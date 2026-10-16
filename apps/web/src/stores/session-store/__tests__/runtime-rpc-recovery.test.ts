// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest, SseEnvelope } from "@covel/shared";
import type { MessageRecord, SessionRecord } from "@/services/api.js";
import type { SessionWorkspace } from "@/services/data-service.js";
import { ApiError } from "@/services/api/request.js";
import { initialState, reducer } from "../reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../sse-handler.js";
import type { SessionAction, SessionState } from "../types.js";
import { claimSessionAction } from "../runtime-refs.js";

const { sendAction } = vi.hoisted(() => ({ sendAction: vi.fn() }));
vi.mock("@/services/api", () => ({ sendAction }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));
const { runActionStream, runSingleSessionAction } =
  await import("../runtime-rpc.js");
const request: ActionRequest = {
  requestId: "request-1",
  sessionId: "session-1",
  type: "retry_runtime",
  payload: { runtimeId: "tracker", retryFromTurnId: "source-turn" },
};

function start() {
  const dispatch = vi.fn();
  const handle = vi.fn();
  const sessionIdRef = { current: request.sessionId as string | null };
  const activeActionRef = { current: null as symbol | null };
  const sessionGenerationRef = { current: 0 };
  const owner = claimSessionAction(
    activeActionRef,
    sessionIdRef,
    request.sessionId,
    request.requestId,
    sessionGenerationRef,
  );
  const pending = runActionStream(request, handle, dispatch, {
    sessionIdRef,
    isCurrentAction: owner.isCurrent,
  });
  const [, onEvent, onError, onDone] = sendAction.mock.calls[0]!;
  return {
    dispatch,
    handle,
    pending,
    sessionIdRef,
    sessionGenerationRef,
    onEvent,
    onError,
    onDone,
    supersede: () =>
      claimSessionAction(activeActionRef, sessionIdRef, request.sessionId),
  };
}

function envelope(
  type: SseEnvelope["type"],
  payload: Record<string, unknown> = {},
): SseEnvelope {
  return {
    type,
    payload,
    requestId: "request-1",
    traceId: "trace-1",
    flowId: "flow-1",
    turnId: "attempt-1",
    seq: 1,
    timestamp: "2026-01-01T00:00:01Z",
    sessionId: request.sessionId,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("durable player input identity", () => {
  function fixture() {
    const dispatch = vi.fn();
    const sessionIdRef = { current: "session-1" as string | null };
    const activeActionRef = { current: null as symbol | null };
    const claimAction = (sid: string) =>
      claimSessionAction(activeActionRef, sessionIdRef, sid, "request-1");
    const inputs: MessageRecord[] = [];
    const workspace: SessionWorkspace = {
      hydrate: async () => {},
      checkpoint: async () => {},
      run: async (_sid, _actionId, mutate, options) => {
        if (options?.input) inputs.push(options.input);
        return mutate();
      },
    };
    const runSingleAction = (
      content: string,
      options: {
        echoUserMessage: boolean;
        owner: ReturnType<typeof claimAction>;
      },
    ) =>
      runSingleSessionAction({
        content,
        ...options,
        dispatch,
        workspace,
        sessionIdRef,
        session: { id: "session-1", locale: "en-US" } as SessionRecord,
        handleSseEvent: vi.fn(),
      });
    return {
      dispatch,
      sessionIdRef,
      claimAction,
      inputs,
      workspace,
      runSingleAction,
    };
  }

  async function finish() {
    await vi.waitFor(() => expect(sendAction).toHaveBeenCalledOnce());
    const [, onEvent, , onDone] = sendAction.mock.calls[0]!;
    onEvent(envelope("execution.completed", { committed: true }));
    onDone();
  }

  it.each(["Look around", "/start adventure"])(
    "binds the durable echo id for %s",
    async (content) => {
      const f = fixture();
      const pending = f.runSingleAction(content, {
        echoUserMessage: true,
        owner: f.claimAction("session-1"),
      });
      await finish();
      await pending;
      const input = f.inputs[0]!;
      expect(sendAction.mock.calls[0]![0]).toMatchObject({
        type: content.startsWith("/") ? "execute_command" : "send_message",
        payload: {
          inputMessageId: input.id,
          ...(content.startsWith("/") ? { command: content } : { content }),
        },
      });
      expect(f.dispatch).toHaveBeenCalledWith({
        type: "ADD_MESSAGE",
        message: {
          id: input.id,
          role: "user",
          content,
          timestamp: input.createdAt,
          requestId: "request-1",
        },
      });
    },
  );
});

describe("action stream recovery", () => {
  it.each(["error", "eof"])(
    "observes the accepted retry after unexpected %s without sending it again",
    async (ending) => {
      const run = start();
      if (ending === "error") {
        run.onError(new Error("Network connection lost"));
        await expect(run.pending).rejects.toThrow("Network connection lost");
      } else {
        run.onDone();
        await run.pending;
      }
      expect(run.dispatch).toHaveBeenCalledWith({
        type: "SET_EXECUTION_RECOVERY",
        recovery: {
          sessionId: "session-1",
          status: null,
          checking: true,
          hydrating: false,
        },
      });
      expect(run.dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_EXECUTION_ERROR" }),
      );
      expect(sendAction).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reopen recovery after an authoritative terminal event", async () => {
    const run = start();
    const terminal: SseEnvelope = {
      type: "execution.completed",
      requestId: "request-1",
      traceId: "trace-1",
      flowId: "flow-1",
      turnId: "attempt-1",
      seq: 1,
      timestamp: "2026-01-01T00:00:01Z",
      sessionId: "session-1",
      payload: { committed: true },
    };
    run.onEvent(terminal);
    run.onDone();
    await run.pending;
    expect(run.handle).toHaveBeenCalledWith(terminal);
    expect(run.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
  });

  it("shows an HTTP rejection without adopting an unrelated previous turn", async () => {
    const run = start();
    run.onError(
      new ApiError(
        409,
        "/api/actions",
        '{"error":"Retry source is no longer current"}',
      ),
    );
    await expect(run.pending).rejects.toThrow();
    expect(run.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_ERROR" }),
    );
    expect(run.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
  });

  it("ignores an old stream ending after the player switches sessions", async () => {
    const run = start();
    run.sessionIdRef.current = "session-2";
    run.onDone();
    await run.pending;
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it("ignores the old stream after revisiting the same session without a new action", async () => {
    const run = start();
    run.sessionGenerationRef.current += 1;
    run.onEvent(envelope("execution.completed", { committed: false }));
    run.onDone();
    await run.pending;
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.handle).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 504])(
    "observes HTTP %i as an unknown outcome without retrying",
    async (status) => {
      const run = start();
      run.onError(new ApiError(status, "/api/actions", "Gateway unavailable"));
      await expect(run.pending).rejects.toThrow();
      expect(run.dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
      );
      expect(sendAction).toHaveBeenCalledOnce();
    },
  );

  it("immediately observes an uncommitted terminal to recover its original input", async () => {
    const run = start();
    run.onEvent(envelope("execution.completed", { committed: false }));
    expect(
      run.dispatch.mock.calls.filter(
        ([action]) => action.type === "SET_EXECUTION_RECOVERY",
      ),
    ).toHaveLength(1);
    run.onDone();
    await run.pending;
    expect(
      run.dispatch.mock.calls.filter(
        ([action]) => action.type === "SET_EXECUTION_RECOVERY",
      ),
    ).toHaveLength(1);
    expect(sendAction).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "only observes a terminal error when execution started: %s",
    async (started) => {
      const run = start();
      if (started) run.onEvent(envelope("execution.started"));
      run.onEvent(envelope("error.occurred", { message: "Runtime failed" }));
      run.onDone();
      await run.pending;
      expect(
        run.dispatch.mock.calls.filter(
          ([action]) => action.type === "SET_EXECUTION_RECOVERY",
        ),
      ).toHaveLength(started ? 1 : 0);
      expect(run.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error.occurred" }),
      );
    },
  );

  it.each(["eof", "error", "rejection"])(
    "ignores stale same-session events and %s after a new owner claims",
    async (ending) => {
      const run = start();
      run.supersede();
      run.onEvent(envelope("execution.completed", { committed: false }));
      if (ending === "eof") {
        run.onDone();
        await run.pending;
      } else {
        run.onError(
          ending === "rejection"
            ? new ApiError(409, "/api/actions", "Rejected")
            : new Error("Network lost"),
        );
        await expect(run.pending).rejects.toThrow();
      }
      expect(run.dispatch).not.toHaveBeenCalled();
      expect(run.handle).not.toHaveBeenCalled();
    },
  );
});

it("claims an echo with the action request ID on the first turn-bearing frame", async () => {
  const run = start();
  run.onEvent(envelope("execution.started"));
  run.onEvent(envelope("execution.completed", { committed: true }));
  run.onDone();
  await run.pending;
  expect(
    run.dispatch.mock.calls.filter(
      ([action]) => action.type === "BACKFILL_TURN_ID",
    ),
  ).toEqual([
    [{ type: "BACKFILL_TURN_ID", turnId: "attempt-1", requestId: "request-1" }],
  ]);
});

it("does not assign a rejected echo to a subsequent action without an echo", async () => {
  let state = initialState;
  const dispatch = (action: SessionAction) => {
    state = reducer(state, action);
  };
  const sessionIdRef = { current: request.sessionId as string | null };
  const handle = createSseEventHandler({
    dispatch,
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef,
    stateRef: { current: state },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  });
  const pending = runSingleSessionAction({
    content: "Rejected input",
    echoUserMessage: true,
    owner: claimSessionAction(
      { current: null },
      sessionIdRef,
      request.sessionId,
      "rejected-request",
    ),
    session: { id: request.sessionId, locale: "en-US" } as SessionRecord,
    workspace: {
      hydrate: async () => {},
      checkpoint: async () => {},
      run: async (_sid, _id, mutate) => mutate(),
    },
    dispatch,
    handleSseEvent: handle,
    sessionIdRef,
  });
  sendAction.mock.calls[0]![2](new ApiError(409, "/api/actions", "busy"));
  await pending;
  const next = runActionStream(request, handle, dispatch, { sessionIdRef });
  const [, onEvent, , onDone] = sendAction.mock.calls[1]!;
  onEvent(envelope("execution.started", { runtimeCount: 0 }));
  onEvent(envelope("execution.completed", { committed: true }));
  onDone();
  await next;
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]?.turnId).toBeUndefined();
  expect(state.messages[0]?.requestId).toBe("rejected-request");
});

describe("stop before turn start", () => {
  it.each(["send_message", "execute_command"] as const)(
    "returns only the %s echo, without recovering a previous turn",
    async (type) => {
      let state: SessionState = {
        ...initialState,
        executing: true,
        messages: [
          {
            id: "old",
            role: "user" as const,
            content: "Older input",
            timestamp: "now",
            requestId: "older-request",
          },
          {
            id: "input",
            role: "user" as const,
            content: "Look around",
            timestamp: "now",
            requestId: request.requestId,
          },
        ],
      };
      const dispatch = vi.fn((action: SessionAction) => {
        state = reducer(state, action);
      });
      const pending = runActionStream(
        {
          ...request,
          ...(type === "send_message"
            ? { type, payload: { content: "Look around" } }
            : { type, payload: { command: "/look" } }),
        },
        vi.fn(),
        dispatch,
      );
      const [, onEvent, , onDone] = sendAction.mock.calls[0]!;
      const terminal = envelope("execution.completed", {
        committed: false,
        abortReason: "aborted-by-player",
      });
      onEvent(terminal);
      onEvent(terminal);
      onDone();
      await pending;
      expect(state.messages.map((message) => message.id)).toEqual(["old"]);
      expect(state.restoredInput).toEqual({
        requestId: request.requestId,
        content: "Look around",
      });
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
      );
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "BACKFILL_TURN_ID" }),
      );
      dispatch({ type: "RESET_SESSION" });
      expect(state.restoredInput).toBeNull();
    },
  );

  it("keeps recovery for a stopped opening after the setup turn started", async () => {
    const run = start();
    run.onEvent(envelope("execution.started"));
    run.onEvent({
      ...envelope("execution.completed", {
        committed: false,
        abortReason: "aborted-by-player",
      }),
      turnId: "opening",
    });
    run.onDone();
    await run.pending;
    expect(run.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
    expect(run.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "RESTORE_STOPPED_INPUT" }),
    );
  });
});
