/**
 * Regression tests for the cross-session contamination hole.
 *
 * Nothing aborts the previous action stream when the player switches sessions
 * mid-turn, so envelopes for session A keep arriving while session B is loaded.
 * Before the guard, every non-delta event was applied to B, and
 * `narrative.completed` persisted A's text under B's session id — permanent in
 * local/IDB mode.
 */
import { describe, expect, it, vi } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import { finalizeActionExecution } from "../session-store/runtime-rpc.js";
import { initialState } from "../session-store/reducer.js";
import type { SessionAction } from "../session-store/types.js";

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

  it("still applies and persists an envelope for the loaded session", () => {
    const dispatch = vi.fn();
    const addMessage = vi.fn().mockResolvedValue(undefined);

    createSseEventHandler(makeDeps(dispatch, addMessage, "sess-a"))(
      narrativeCompleted("sess-a"),
    );

    expect(dispatch.mock.calls.map(([a]) => a.type)).toContain(
      "COMPLETE_MESSAGE",
    );
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-a", id: "msg-1" }),
    );
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
