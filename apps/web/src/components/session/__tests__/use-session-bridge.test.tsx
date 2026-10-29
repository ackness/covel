import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
    ],
    submittedBlockIds: new Set<string>(),
    gameState: { characters: [] },
  },
  slots: [],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: mocks.state }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({ useUiSlots: () => mocks.slots }));
afterEach(() => {
  cleanup();
  clearAllStreamingText();
  vi.restoreAllMocks();
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
