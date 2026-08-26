/**
 * Regression tests for the delta-buffer session-switch race.
 *
 * A narrative delta is buffered until the next animation frame. The handler
 * must only publish that buffered delta when the session which queued it is
 * still loaded at flush time; otherwise an old stream can create a placeholder
 * in the newly selected session.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  clearAllStreamingText,
  getStreamingText,
} from "@/stores/streaming-text-store.js";
import { initialState, reducer } from "../session-store/reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import type { SessionAction, SessionState } from "../session-store/types.js";

interface RafHarness {
  flush(frameId: number): void;
  pendingFrameId(): number;
}

function installRafHarness(): RafHarness {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      const frameId = nextFrameId++;
      callbacks.set(frameId, callback);
      return frameId;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (frameId: number): void => {
    callbacks.delete(frameId);
  });

  return {
    flush(frameId) {
      const callback = callbacks.get(frameId);
      if (!callback) throw new Error(`No pending frame ${frameId}`);
      callbacks.delete(frameId);
      callback(0);
    },
    pendingFrameId() {
      const [frameId] = callbacks.keys();
      if (frameId === undefined) throw new Error("No pending animation frame");
      return frameId;
    },
  };
}

function narrativeDelta(
  delta = "Hello ",
  sessionId = "session-a",
): SseEnvelope {
  return {
    type: "narrative.delta",
    requestId: "req-1",
    traceId: "trace-1",
    sessionId,
    turnId: "turn-1",
    flowId: "trace-1",
    seq: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
    payload: {
      delta,
      runtimeId: "narrator",
      pluginId: "narrator",
      kind: "story",
    },
  };
}

function createHarness(sessionId = "session-a") {
  const actions: SessionAction[] = [];
  const stateRef: { current: SessionState } = { current: initialState };
  const sessionIdRef = { current: sessionId as string | null };
  const deps: SseEventHandlerDeps = {
    dispatch(action) {
      actions.push(action);
      stateRef.current = reducer(stateRef.current, action);
    },
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef,
    stateRef,
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };

  return {
    actions,
    deps,
    handle: createSseEventHandler(deps),
    sessionIdRef,
    state: () => stateRef.current,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAllStreamingText();
});

describe("sse-handler narrative delta buffer", () => {
  it("flushes coalesced story deltas into the current session's reducer state", () => {
    const raf = installRafHarness();
    const harness = createHarness();

    harness.handle(narrativeDelta());
    harness.handle({
      ...narrativeDelta(),
      seq: 2,
      payload: narrativeDelta("world.").payload,
    });
    raf.flush(raf.pendingFrameId());

    expect(harness.state().messages).toMatchObject([
      {
        id: "stream_turn-1_narrator",
        turnId: "turn-1",
        runtimeId: "narrator",
        kind: "story",
      },
    ]);
    expect(getStreamingText("stream_turn-1_narrator")).toBe("Hello world.");
    expect(
      harness.actions.filter((action) => action.type === "APPEND_DELTA"),
    ).toEqual([
      {
        type: "APPEND_DELTA",
        turnId: "turn-1",
        runtimeId: "narrator",
        pluginId: "narrator",
        delta: "Hello world.",
      },
    ]);
    expect(harness.deps.deltaBufferRef.current.size).toBe(0);
    expect(harness.deps.deltaRafRef.current).toBeNull();
  });

  it("drops a queued delta when the player switches sessions before its frame flushes", () => {
    const raf = installRafHarness();
    const harness = createHarness("session-a");

    harness.handle(narrativeDelta());
    harness.sessionIdRef.current = "session-b";
    raf.flush(raf.pendingFrameId());

    expect(harness.state().messages).toEqual([]);
    expect(harness.actions.map((action) => action.type)).toEqual([
      "BACKFILL_TURN_ID",
    ]);
    expect(getStreamingText("stream_turn-1_narrator")).toBeUndefined();
    expect(harness.deps.deltaBufferRef.current.size).toBe(0);
    expect(harness.deps.deltaRafRef.current).toBeNull();
  });

  it("drops a queued delta when the session is detached before its frame flushes", () => {
    const raf = installRafHarness();
    const harness = createHarness("session-a");

    harness.handle(narrativeDelta());
    harness.sessionIdRef.current = null;
    raf.flush(raf.pendingFrameId());

    expect(harness.state().messages).toEqual([]);
    expect(harness.actions.map((action) => action.type)).toEqual([
      "BACKFILL_TURN_ID",
    ]);
    expect(getStreamingText("stream_turn-1_narrator")).toBeUndefined();
    expect(harness.deps.deltaBufferRef.current.size).toBe(0);
    expect(harness.deps.deltaRafRef.current).toBeNull();
  });
});
