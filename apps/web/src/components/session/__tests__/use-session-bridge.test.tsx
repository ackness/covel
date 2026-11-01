import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import { useSessionBridge } from "../use-session-bridge.js";
const story = (
  id: string,
  content = "Previous committed story",
): StreamMessage => ({
  id,
  role: "assistant",
  kind: "story",
  content,
  timestamp: "private",
});
const mocks = vi.hoisted(() => ({
  state: {
    session: { id: "s", phase: "playing", completedPlayerTurns: 1 },
    executing: true,
    messages: [] as StreamMessage[],
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
    session: { id: "s", phase: "playing", completedPlayerTurns: 1 },
    executing: true,
    messages: [story("saved")],
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps previous complete story while running and projects the next durable completion", () => {
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection).toMatchObject({
    version: 3,
    executing: true,
    messages: [{ seq: 1, text: "Previous committed story" }],
  });
  expect(result.current).not.toHaveProperty("stream");
  expect(result.current.projection).not.toHaveProperty("streaming");
  mocks.state = {
    ...mocks.state,
    messages: [...mocks.state.messages, story("next", "Full next story")],
  };
  rerender();
  expect(result.current.projection?.messages.map((m) => m.text)).toEqual([
    "Previous committed story",
    "Full next story",
  ]);
});
it("keeps durable ordinals through eviction, redelivery and history prepend", () => {
  const saved = story("saved");
  const current = story("current");
  mocks.state.messages = [saved, current];
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection?.messages.map((m) => m.seq)).toEqual([1, 2]);
  mocks.state = { ...mocks.state, messages: [{ ...current }] };
  rerender();
  expect(result.current.projection?.messages[0]?.seq).toBe(2);
  mocks.state = { ...mocks.state, messages: [story("older"), saved, current] };
  rerender();
  expect(result.current.projection?.messages.map((m) => m.seq)).toEqual([
    3, 1, 2,
  ]);
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

it("builds version three from public lanes while unrelated private state changes", () => {
  const publicStory: StreamMessage = {
    id: "public",
    role: "assistant",
    kind: "story",
    content: "A public story",
    timestamp: "internal",
  };
  const next = {
    ...mocks.state,
    messages: [
      publicStory,
      {
        ...publicStory,
        id: "private",
        kind: "plugin",
        content: "credential-sentinel",
      },
    ],
    runtimeResults: [
      {
        providerContinuation: "credential-sentinel",
        reasoningContent: "credential-sentinel",
      },
    ],
    jobs: { private: "credential-sentinel" },
    context: { private: "credential-sentinel" },
  };
  mocks.state = next;
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection).toMatchObject({
    version: 3,
    messages: [{ text: "A public story" }],
    input: { seats: [], kinds: [] },
  });
  mocks.state = { ...next, executing: false };
  rerender();
  expect(JSON.stringify(result.current.projection)).not.toContain(
    "credential-sentinel",
  );
  expect(result.current.projection?.messages).toHaveLength(1);
});
