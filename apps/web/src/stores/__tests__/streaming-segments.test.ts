/**
 * Live paragraph metadata on `narrative.delta`: it is buffered with the text
 * and applied in the same animation frame, a metadata-only delta still
 * flushes, and a reset or the committed story clears it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SseEnvelope } from "@/services/api";
import {
  clearAllStreamingText,
  getStreamingSpeakers,
  getStreamingText,
} from "@/stores/streaming-text-store.js";
import { initialState, reducer } from "../session-store/reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "../session-store/sse-handler.js";
import type { SessionAction, SessionState } from "../session-store/types.js";

const STREAM_ID = "stream_turn-1_narrator";

function installRaf() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frameId = nextFrameId++;
    callbacks.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
    callbacks.delete(frameId);
  });
  return {
    pending: () => callbacks.size,
    flush() {
      for (const [frameId, callback] of [...callbacks]) {
        callbacks.delete(frameId);
        callback(0);
      }
    },
  };
}

function envelope(
  type: "narrative.delta" | "narrative.completed",
  payload: Record<string, unknown>,
): SseEnvelope {
  return {
    type,
    requestId: "req-1",
    traceId: "trace-1",
    sessionId: "session-a",
    turnId: "turn-1",
    flowId: "trace-1",
    seq: 1,
    timestamp: "2026-10-30T00:00:00.000Z",
    payload: {
      runtimeId: "narrator",
      pluginId: "narrator",
      kind: "story",
      ...payload,
    },
  };
}

const delta = (text: string, extra: Record<string, unknown> = {}) =>
  envelope("narrative.delta", { delta: text, ...extra });

function createHarness() {
  const actions: SessionAction[] = [];
  const stateRef: { current: SessionState } = { current: initialState };
  const deps: SseEventHandlerDeps = {
    dispatch(action) {
      actions.push(action);
      stateRef.current = reducer(stateRef.current, action);
    },
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: "session-a" },
    stateRef,
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
  return { actions, handle: createSseEventHandler(deps) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearAllStreamingText();
});

describe("live paragraph metadata", () => {
  it("applies metadata in the same flush as its text, latest per paragraph", () => {
    const raf = installRaf();
    const harness = createHarness();
    harness.handle(
      delta("雨停了。", { segment: { index: 0, kind: "narration" } }),
    );
    harness.handle(
      delta("\n\n「走", { segment: { index: 1, kind: "dialogue" } }),
    );
    harness.handle(
      delta("", {
        segment: { index: 1, kind: "dialogue", speaker: "小雅" },
      }),
    );
    expect(getStreamingText(STREAM_ID)).toBeUndefined();
    expect(getStreamingSpeakers(STREAM_ID)).toBeUndefined();
    raf.flush();
    expect(getStreamingText(STREAM_ID)).toBe("雨停了。\n\n「走");
    expect(getStreamingSpeakers(STREAM_ID)).toEqual([null, "小雅"]);
  });

  it("flushes a metadata-only delta without touching the text", () => {
    const raf = installRaf();
    const harness = createHarness();
    harness.handle(
      delta("「走吧。」", { segment: { index: 0, kind: "dialogue" } }),
    );
    raf.flush();
    expect(getStreamingSpeakers(STREAM_ID)).toEqual([null]);
    const appended = harness.actions.filter(
      (action) => action.type === "APPEND_DELTA",
    ).length;
    harness.handle(
      delta("", { segment: { index: 0, kind: "dialogue", speaker: "小雅" } }),
    );
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(getStreamingSpeakers(STREAM_ID)).toEqual(["小雅"]);
    expect(getStreamingText(STREAM_ID)).toBe("「走吧。」");
    expect(
      harness.actions.filter((action) => action.type === "APPEND_DELTA"),
    ).toHaveLength(appended);
  });

  it("ignores malformed metadata and keeps prose without any", () => {
    const raf = installRaf();
    const harness = createHarness();
    harness.handle(delta("Plain prose."));
    harness.handle(delta("", { segment: { index: -1, kind: "dialogue" } }));
    harness.handle(delta("", { segment: { index: 0, kind: "aside" } }));
    raf.flush();
    expect(getStreamingText(STREAM_ID)).toBe("Plain prose.");
    expect(getStreamingSpeakers(STREAM_ID)).toBeUndefined();
  });

  it("clears metadata on a reset and when the story commits", () => {
    const raf = installRaf();
    const harness = createHarness();
    harness.handle(
      delta("draft", {
        segment: { index: 0, kind: "dialogue", speaker: "小雅" },
      }),
    );
    raf.flush();
    expect(getStreamingSpeakers(STREAM_ID)).toEqual(["小雅"]);
    harness.handle(delta("", { reset: true }));
    expect(getStreamingSpeakers(STREAM_ID)).toBeUndefined();

    harness.handle(
      delta("「走吧。」", {
        reset: true,
        segment: { index: 0, kind: "dialogue", speaker: "小雅" },
      }),
    );
    raf.flush();
    expect(getStreamingSpeakers(STREAM_ID)).toEqual(["小雅"]);
    harness.handle(
      envelope("narrative.completed", {
        content: "「走吧。」",
        messageId: "story-1",
        segments: [
          {
            kind: "dialogue",
            speaker: "阿雅",
            speakerId: "char-aya",
            text: "「走吧。」",
          },
        ],
      }),
    );
    expect(getStreamingSpeakers(STREAM_ID)).toBeUndefined();
    expect(getStreamingText(STREAM_ID)).toBeUndefined();
  });
});
