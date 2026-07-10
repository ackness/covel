/**
 * Player abort terminal state (audit 2026-07-10 A-04).
 *
 * After the player clicks Stop mid-stream, the server never commits the
 * partial narrative — the client must discard the `stream_<turnId>_<runtimeId>`
 * placeholder created by APPEND_DELTA (otherwise the player sees ghost text
 * that vanishes on refresh) and must NOT surface `aborted-by-player` as a
 * red retryable error.
 */

import { describe, it, expect, vi } from "vitest";
import { PLAYER_ABORT_REASON } from "@covel/shared";
import type { SseEnvelope } from "@/services/api";
import { initialState, reducer } from "../session-store/reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import type { SessionAction, SessionState } from "../session-store/types.js";

function appendDelta(state: SessionState, turnId: string): SessionState {
  return reducer(state, {
    type: "APPEND_DELTA",
    turnId,
    runtimeId: "narrator/main",
    pluginId: "narrator",
    delta: "half-written narrative…",
  });
}

describe("reducer DISCARD_TURN_STREAMS", () => {
  it("removes the streaming placeholder for the aborted turn, keeps everything else", () => {
    let state = reducer(initialState, {
      type: "ADD_MESSAGE",
      message: {
        id: "m1",
        role: "user",
        content: "hi",
        timestamp: "2026-07-10T00:00:00Z",
      },
    });
    state = appendDelta(state, "turn-1");
    state = appendDelta(state, "turn-2");
    expect(state.messages).toHaveLength(3);

    state = reducer(state, { type: "DISCARD_TURN_STREAMS", turnId: "turn-1" });

    expect(state.messages.map((m) => m.id)).toEqual([
      "m1",
      "stream_turn-2_narrator/main",
    ]);
  });

  it("without turnId, discards all streaming placeholders", () => {
    let state = appendDelta(initialState, "turn-1");
    state = appendDelta(state, "turn-2");

    state = reducer(state, { type: "DISCARD_TURN_STREAMS" });

    expect(state.messages).toHaveLength(0);
  });
});

describe("sse-handler execution.completed abort terminal state", () => {
  function makeDeps(dispatch: (a: SessionAction) => void): SseEventHandlerDeps {
    return {
      dispatch,
      ds: {} as SseEventHandlerDeps["ds"],
      sessionIdRef: { current: "sess-1" },
      stateRef: { current: initialState },
      runtimeKindRef: { current: new Map() },
      deltaBufferRef: { current: new Map() },
      deltaRafRef: { current: null },
      lastBackfilledTurnIdRef: { current: "turn-1" },
    };
  }

  function completedEnvelope(abortReason: string): SseEnvelope {
    return {
      type: "execution.completed",
      requestId: "req-1",
      traceId: "trace-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      flowId: "trace-1",
      seq: 9,
      timestamp: "2026-07-10T00:00:01Z",
      payload: {
        runtimeCount: 1,
        resultCount: 0,
        durationMs: 5,
        abortReason,
      },
    };
  }

  it("player abort → discard placeholders, no execution error", () => {
    const dispatch = vi.fn();
    const handle = createSseEventHandler(makeDeps(dispatch));

    handle(completedEnvelope(PLAYER_ABORT_REASON));

    const types = dispatch.mock.calls.map(([a]) => a.type);
    expect(types).toContain("DISCARD_TURN_STREAMS");
    expect(types).not.toContain("SET_EXECUTION_ERROR");
    expect(dispatch).toHaveBeenCalledWith({
      type: "DISCARD_TURN_STREAMS",
      turnId: "turn-1",
    });
  });

  it("non-player abort reasons still surface as an execution error", () => {
    const dispatch = vi.fn();
    const handle = createSseEventHandler(makeDeps(dispatch));

    handle(completedEnvelope("budget-cap-exceeded"));

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_EXECUTION_ERROR",
      error: "budget-cap-exceeded",
    });
    const types = dispatch.mock.calls.map(([a]) => a.type);
    expect(types).not.toContain("DISCARD_TURN_STREAMS");
  });
});
