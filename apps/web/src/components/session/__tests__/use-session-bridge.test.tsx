import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { SseEnvelope } from "@/services/api.js";
import { initialState, reducer } from "@/stores/session-store/reducer.js";
import {
  createSseEventHandler,
  type SseEventHandlerDeps,
} from "@/stores/session-store/sse-handler.js";
import { createStreamPump } from "../session-bridge-stream.js";
import { useSessionBridge } from "../use-session-bridge.js";
import {
  appendStreamingText,
  clearAllStreamingText,
  clearStreamingText,
} from "@/stores/streaming-text-store.js";
const mocks = vi.hoisted(() => ({
  state: {
    session: { id: "s", phase: "playing", completedPlayerTurns: 1 },
    executing: true,
    messages: [
      {
        id: "stream_s",
        role: "assistant",
        kind: "story",
        content: "",
        timestamp: "private",
      },
    ] as StreamMessage[],
    submittedBlockIds: new Set<string>(),
    gameState: { characters: [] },
  },
  slots: [],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: mocks.state }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => mocks.slots,
  applyUiSlotEvent: () => false,
}));
beforeEach(() => {
  mocks.state = {
    ...mocks.state,
    executing: true,
    session: { id: "s", phase: "playing", completedPlayerTurns: 1 },
    messages: [
      {
        id: "stream_s",
        role: "assistant",
        kind: "story",
        content: "",
        timestamp: "private",
      },
    ],
  };
});
afterEach(() => {
  cleanup();
  clearAllStreamingText();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocks.state.session.phase = "playing";
});
it("keeps React projection stable for text appends and includes current text in the next full snapshot", () => {
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  const original = result.current.projection;
  const notify = vi.fn();
  const unsubscribe = result.current.stream.subscribe(notify);
  act(() => {
    appendStreamingText("stream_s", "tail");
  });
  expect(notify).toHaveBeenCalledOnce();
  expect(result.current.projection).toBe(original);
  expect(result.current.stream.read()).toEqual({ seq: 1, text: "tail" });
  act(() => clearStreamingText("stream_s"));
  expect(result.current.stream.read()).toEqual({ seq: 1, text: "tail" });
  act(() => appendStreamingText("stream_s", "tail"));
  rerender();
  expect(result.current.projection).toBe(original);
  mocks.state = { ...mocks.state, executing: false };
  rerender();
  expect(result.current.projection?.streaming?.text).toBe("tail");
  unsubscribe();
});
it("withholds invalid projections with a single warning", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.state = {
    ...mocks.state,
    session: { ...mocks.state.session, phase: "invalid" },
  };
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection).toBeUndefined();
  mocks.state = { ...mocks.state, executing: !mocks.state.executing };
  rerender();
  expect(result.current.projection).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
});

it("replaces a reset narrative that regrows past its old length before the bridge flush", () => {
  vi.useFakeTimers();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  const flushFrame = () => {
    const pending = frame;
    if (!pending) throw new Error("No queued frame");
    frame = undefined;
    pending(0);
  };
  const streamId = "stream_turn-1_narrator";
  mocks.state.messages = [
    {
      id: streamId,
      role: "assistant",
      kind: "story",
      content: "",
      timestamp: "private",
      turnId: "turn-1",
      runtimeId: "narrator",
    },
  ];
  const stateRef = {
    current: { ...initialState, messages: mocks.state.messages },
  };
  const deps: SseEventHandlerDeps = {
    dispatch: (action) => {
      stateRef.current = reducer(stateRef.current, action);
      mocks.state = { ...mocks.state, messages: stateRef.current.messages };
    },
    ds: {} as SseEventHandlerDeps["ds"],
    sessionIdRef: { current: "s" },
    stateRef,
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  };
  const handle = createSseEventHandler(deps);
  const delta = (text: string, reset = false): SseEnvelope => ({
    type: "narrative.delta",
    sessionId: "s",
    turnId: "turn-1",
    requestId: "r",
    traceId: "trace",
    flowId: "flow",
    seq: 1,
    timestamp: "2026-10-29T00:00:00Z",
    payload: {
      kind: "story",
      runtimeId: "narrator",
      pluginId: "fixture",
      delta: text,
      ...(reset ? { reset: true } : {}),
    },
  });
  const { result } = renderHook(() => useSessionBridge("s"));
  let pageText = "";
  const send = vi.fn(({ append }: { append: string }) => {
    pageText += append;
  });
  const resync = vi.fn(() => {
    const current = result.current.stream.read();
    pageText = current?.text ?? "";
    pump.baseline(current?.seq ?? 0, pageText.length);
  });
  const pump = createStreamPump({
    read: result.current.stream.read,
    send,
    resync,
    intervalMs: 100,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
  });
  pump.baseline(1, 0);
  const off = result.current.stream.subscribe((change) => pump.notify(change));
  act(() => {
    handle(delta("Discarded draft"));
    flushFrame();
    vi.advanceTimersByTime(100);
  });
  expect(pageText).toBe("Discarded draft");
  const replacement = "A replacement longer than the discarded draft";
  act(() => {
    handle(delta("", true));
    handle(delta(replacement));
    flushFrame();
    vi.advanceTimersByTime(99);
  });
  expect(resync).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(pageText).toBe(replacement);
  expect(resync).toHaveBeenCalledOnce();
  expect(send.mock.calls.map(([value]) => value.append)).toEqual([
    "Discarded draft",
  ]);
  act(() => {
    handle(delta(" continues"));
    flushFrame();
    vi.advanceTimersByTime(100);
  });
  expect(pageText).toBe(replacement + " continues");
  off();
  pump.dispose();
});

it("uses the same stable ordinal for the projection and feed across eviction and history prepend", () => {
  const old: StreamMessage = {
    id: "old",
    role: "user",
    content: "Old",
    timestamp: "private",
  };
  const live: StreamMessage = {
    id: "stream_s",
    role: "assistant",
    kind: "story",
    content: "",
    timestamp: "private",
  };
  mocks.state.messages = [old, live];
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.stream.read()?.seq).toBe(2);
  mocks.state = { ...mocks.state, messages: [live] };
  rerender();
  expect(result.current.projection?.streaming?.seq).toBe(2);
  expect(result.current.stream.read()?.seq).toBe(2);
  mocks.state = {
    ...mocks.state,
    messages: [{ ...old, id: "history" }, old, live],
  };
  rerender();
  expect(result.current.projection?.streaming?.seq).toBe(2);
  expect(result.current.stream.read()?.seq).toBe(2);
  expect(
    result.current.projection?.messages.map((message) => message.seq),
  ).toEqual([3, 1]);
});
