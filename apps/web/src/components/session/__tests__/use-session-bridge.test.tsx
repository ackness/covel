import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { OutputDraft } from "@/stores/session-store/output-drafts.js";
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
    outputDrafts: [] as OutputDraft[],
    submittedBlockIds: new Set<string>(),
    gameState: { characters: [] },
  },
  slots: [],
  liveOutput: "units",
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: (key: string) => [
    key === "ui.liveOutput" ? mocks.liveOutput : undefined,
  ],
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
    outputDrafts: [],
  };
  mocks.liveOutput = "units";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps previous complete story while running and projects the next durable completion", () => {
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection).toMatchObject({
    version: 4,
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

it("builds version four from public lanes while unrelated private state changes", () => {
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
    version: 4,
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

it("shows a story being written as far as the player reads it, without its identity", () => {
  const draft: OutputDraft = {
    turnId: "turn-sentinel",
    runtimeId: "runtime-sentinel",
    pluginId: "plugin-sentinel",
    draftId: "draft-sentinel",
    units: [
      { text: "The rain stopped.", meta: { kind: "narration" } },
      { text: "“Let's go.”", meta: { kind: "dialogue", speaker: "Aya" } },
    ],
    partial: { text: "“Wai", meta: { kind: "dialogue", speaker: "Ren" } },
    accepted: false,
    revising: false,
  };
  mocks.state = { ...mocks.state, outputDrafts: [draft] };
  const { result, rerender } = renderHook(() => useSessionBridge("s"));
  expect(result.current.projection?.drafts).toEqual([
    {
      state: "writing",
      text: "The rain stopped.\n\n“Let's go.”",
      lines: [
        { kind: "narration", text: "The rain stopped." },
        { kind: "dialogue", text: "“Let's go.”", speaker: "Aya" },
      ],
    },
  ]);
  expect(JSON.stringify(result.current.projection)).not.toContain("sentinel");

  mocks.liveOutput = "text";
  rerender();
  expect(result.current.projection?.drafts[0]?.text).toBe(
    "The rain stopped.\n\n“Let's go.”\n\n“Wai",
  );
  expect(result.current.projection?.drafts[0]?.lines?.at(-1)).toEqual({
    kind: "dialogue",
    text: "“Wai",
    speaker: "Ren",
  });

  mocks.state = {
    ...mocks.state,
    outputDrafts: [{ ...draft, units: [], partial: undefined, revising: true }],
  };
  const before = result.current.projection?.messages;
  rerender();
  expect(result.current.projection?.drafts).toEqual([
    { state: "revising", text: "" },
  ]);
  // A draft update leaves the projected message log as it was.
  expect(result.current.projection?.messages).toBe(before);

  mocks.state = {
    ...mocks.state,
    outputDrafts: [{ ...draft, partial: undefined, accepted: true }],
  };
  rerender();
  expect(result.current.projection?.drafts[0]?.state).toBe("accepted");

  // A player who waits for the commit sees no draft, so neither does the page.
  mocks.liveOutput = "committed";
  rerender();
  expect(result.current.projection?.drafts).toEqual([]);
});
