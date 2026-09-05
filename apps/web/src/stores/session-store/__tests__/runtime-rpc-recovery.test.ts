import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest, SseEnvelope } from "@covel/shared";
import { ApiError } from "@/services/api/request.js";
import { claimSessionAction } from "../runtime-refs.js";

const { sendAction } = vi.hoisted(() => ({ sendAction: vi.fn() }));
vi.mock("@/services/api", () => ({ sendAction }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));
const { runActionStream } = await import("../runtime-rpc.js");
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
  const owner = claimSessionAction(
    activeActionRef,
    sessionIdRef,
    request.sessionId,
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
    expect(run.dispatch).not.toHaveBeenCalled();
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
    expect(run.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "SET_EXECUTION_RECOVERY" }),
    );
    run.onDone();
    await run.pending;
    expect(run.dispatch).toHaveBeenCalledOnce();
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
      expect(run.dispatch).toHaveBeenCalledTimes(started ? 1 : 0);
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
