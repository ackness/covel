/**
 * Regression tests for the cross-session contamination hole.
 *
 * Nothing aborts the previous action stream when the player switches sessions
 * mid-turn, so envelopes for session A keep arriving while session B is loaded.
 * Before the guard, every non-delta event was applied to B, and
 * `narrative.completed` persisted A's text under B's session id — permanent in
 * local/IDB mode.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/services/api";
import type { SseEnvelope } from "@/services/api";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import {
  finalizeActionExecution,
  runActionStream,
} from "../session-store/runtime-rpc.js";
import { useBuildSessionActions } from "../session-store/actions.js";
import { initialState } from "../session-store/reducer.js";
import type { SessionRuntimeRefs } from "../session-store/runtime-refs.js";
import type { SessionAction } from "../session-store/types.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(
  dispatch: (a: SessionAction) => void,
  addMessage: ReturnType<typeof vi.fn>,
  currentSessionId: string | null,
): SseEventHandlerDeps {
  return {
    dispatch,
    ds: { addMessage } as unknown as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: currentSessionId },
    stateRef: { current: initialState },
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
}

function narrativeCompleted(sessionId: string): SseEnvelope {
  return {
    type: "narrative.completed",
    requestId: "req-1",
    traceId: "trace-1",
    sessionId,
    turnId: "turn-1",
    flowId: "trace-1",
    seq: 3,
    timestamp: "2026-07-25T00:00:01Z",
    payload: {
      content: "The old session's narrative.",
      runtimeId: "narrator/main",
      messageId: "msg-1",
      kind: "story",
    },
  };
}

describe("sse-handler — foreign-session envelopes", () => {
  it("drops an envelope for a session other than the loaded one", () => {
    const dispatch = vi.fn();
    const addMessage = vi.fn().mockResolvedValue(undefined);

    createSseEventHandler(makeDeps(dispatch, addMessage, "sess-b"))(
      narrativeCompleted("sess-a"),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("applies a loaded-session envelope without creating a local revision", () => {
    const dispatch = vi.fn();
    const addMessage = vi.fn().mockResolvedValue(undefined);

    createSseEventHandler(makeDeps(dispatch, addMessage, "sess-a"))(
      narrativeCompleted("sess-a"),
    );

    expect(dispatch.mock.calls.map(([a]) => a.type)).toContain(
      "COMPLETE_MESSAGE",
    );
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("does not drop events before a session is loaded", () => {
    const dispatch = vi.fn();
    const addMessage = vi.fn().mockResolvedValue(undefined);

    createSseEventHandler(makeDeps(dispatch, addMessage, null))(
      narrativeCompleted("sess-a"),
    );

    expect(dispatch.mock.calls.map(([a]) => a.type)).toContain(
      "COMPLETE_MESSAGE",
    );
  });
});

describe("finalizeActionExecution — stale stream", () => {
  it("does not settle the new session when an old stream ends", () => {
    const dispatch = vi.fn();

    finalizeActionExecution(dispatch, "sess-a", { current: "sess-b" });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("settles normally when the stream belongs to the loaded session", () => {
    const dispatch = vi.fn();

    finalizeActionExecution(dispatch, "sess-a", { current: "sess-a" });

    expect(dispatch.mock.calls.map(([a]) => a.type)).toEqual([
      "SET_EXECUTING",
      "FINALIZE_HANGING_RUNTIMES",
    ]);
  });
});

describe("runtime RPC — originating session", () => {
  it("does not report a stale action transport error in the new session", async () => {
    vi.spyOn(api, "sendAction").mockImplementation(
      (_request, _onEvent, onError) => {
        onError?.(new Error("session A failed"));
        return new AbortController();
      },
    );
    const dispatch = vi.fn();

    await runActionStream(
      {
        requestId: "req-1",
        type: "send_message",
        sessionId: "sess-a",
        payload: { content: "hello" },
      },
      vi.fn(),
      dispatch,
      { sessionIdRef: { current: "sess-b" } },
    ).catch(() => undefined);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops stream events after the player switches sessions", async () => {
    vi.spyOn(api, "sendAction").mockImplementation(
      (_request, onEvent, _onError, onDone) => {
        onEvent(narrativeCompleted("sess-a"));
        onDone?.();
        return new AbortController();
      },
    );
    const handleSseEvent = vi.fn();

    await runActionStream(
      {
        requestId: "req-1",
        type: "send_message",
        sessionId: "sess-a",
        payload: { content: "hello" },
      },
      handleSseEvent,
      vi.fn(),
      { sessionIdRef: { current: "sess-b" } },
    );

    expect(handleSseEvent).not.toHaveBeenCalled();
  });

  it("does not begin adventure when the overlay resolves after a switch", async () => {
    let resolveOverlay!: (value: null) => void;
    vi.spyOn(api, "getWorldOverlay").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOverlay = resolve;
      }),
    );
    const sendAction = vi.spyOn(api, "sendAction");
    const dispatch = vi.fn();
    const sessionIdRef = { current: "sess-a" as string | null };
    const state = {
      ...initialState,
      world: {
        id: "world-a",
        name: "World A",
        description: "",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      session: {
        id: "sess-a",
        worldId: "world-a",
        status: "active" as const,
        phase: "setup" as const,
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [],
        locale: "en-US",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    const refs: SessionRuntimeRefs = {
      stateRef: { current: state },
      sessionIdRef,
      runtimeKindRef: { current: new Map() },
      deltaBufferRef: { current: new Map() },
      deltaRafRef: { current: null },
      lastBackfilledTurnIdRef: { current: null },
    };
    const { result } = renderHook(() =>
      useBuildSessionActions({
        state,
        dispatch,
        ds: {} as SseEventHandlerDeps["ds"],
        workspace: {
          hydrate: vi.fn(),
          run: vi.fn(),
          checkpoint: vi.fn(),
        },
        refs,
        handleSseEvent: vi.fn(),
      }),
    );

    act(() => result.current.beginAdventure());
    sessionIdRef.current = "sess-b";
    resolveOverlay(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendAction).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "SET_EXECUTING",
      value: true,
    });
  });
});
