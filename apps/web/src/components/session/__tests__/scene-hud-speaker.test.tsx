import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  clearAllStreamingText,
  setStreamingSegment,
} from "@/stores/streaming-text-store.js";

const hud = vi.hoisted(() => ({
  messages: [] as StreamMessage[],
  slots: [] as Array<{ slot: string; key?: string; value: unknown }>,
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { messages: hud.messages } }),
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlots: () => hud.slots,
  useUiSlot: () => undefined,
}));
vi.mock("../player-status.js", () => ({
  usePlayerStatus: () => null,
  PlayerItems: () => null,
  PlayerStatusMeters: () => null,
}));
vi.mock("../session-summary.js", () => ({
  useSessionSummary: () => [],
  readoutLines: () => [],
  SummaryLines: () => null,
}));

const { SceneHud } = await import("../scene-hud.js");

const cast = {
  slot: "stage.cast@1",
  value: {
    actors: [
      { characterId: "char-chen", displayName: "陈远" },
      { characterId: "char-aya", displayName: "阿雅" },
    ],
    retainWhenEmpty: true,
  },
};
const story = (id: string): StreamMessage => ({
  id,
  role: "assistant",
  kind: "story",
  content: "「走吧。」\n\n雨停了。",
  timestamp: "2026-10-30T00:00:00.000Z",
  segments: [
    {
      kind: "dialogue",
      speaker: "阿雅",
      speakerId: "char-aya",
      text: "「走吧。」",
    },
    { kind: "narration", text: "雨停了。" },
  ],
});

afterEach(() => {
  cleanup();
  clearAllStreamingText();
  hud.messages = [];
  hud.slots = [];
});

const speakingCard = () =>
  screen.queryByText(/^(?:正在说话|Speaking)$/)?.closest("li")?.textContent ??
  null;

describe("scene HUD speaking marker", () => {
  it("marks the last attributed segment's speaker of the latest story", () => {
    hud.slots = [cast];
    hud.messages = [story("story-1")];
    render(<SceneHud sessionId="s" />);
    expect(speakingCard()).toContain("阿雅");
  });

  it("marks the last live speaker by name while the story streams", () => {
    hud.slots = [cast];
    hud.messages = [story("stream_turn_narrator")];
    setStreamingSegment("stream_turn_narrator", {
      index: 0,
      kind: "dialogue",
      speaker: "阿雅",
    });
    setStreamingSegment("stream_turn_narrator", {
      index: 1,
      kind: "narration",
    });
    render(<SceneHud sessionId="s" />);
    expect(speakingCard()).toContain("阿雅");
  });

  it("marks nobody while a streaming story has no live speaker", () => {
    hud.slots = [cast];
    hud.messages = [story("stream_turn_narrator")];
    // The placeholder's own segments are not read while it streams.
    render(<SceneHud sessionId="s" />);
    expect(speakingCard()).toBeNull();
    cleanup();
    setStreamingSegment("stream_turn_narrator", {
      index: 0,
      kind: "narration",
    });
    render(<SceneHud sessionId="s" />);
    expect(speakingCard()).toBeNull();
  });
});
