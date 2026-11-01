// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  lastStorySpeaker,
  splitStageParagraphs,
  stageParagraphSpeakerName,
  storyParagraphSpeakers,
} from "../stage-dialogue-selectors.js";

const segments = [
  { kind: "narration" as const, text: "雨停了。" },
  {
    kind: "dialogue" as const,
    speaker: "阿雅",
    speakerId: "char-aya",
    text: "「走吧。」",
  },
  { kind: "dialogue" as const, speaker: "陌生人", text: "「等等！」" },
  { kind: "narration" as const, text: "风起了。" },
];

describe("story segment speakers", () => {
  it("names each paragraph from the committed segments", () => {
    expect(storyParagraphSpeakers({ segments })).toEqual([
      null,
      "阿雅",
      "陌生人",
      null,
    ]);
    expect(storyParagraphSpeakers({})).toBeUndefined();
  });

  it("reads the last attributed segment of a committed story", () => {
    expect(lastStorySpeaker({ id: "msg-1", segments })).toEqual({
      name: "陌生人",
    });
    expect(
      lastStorySpeaker({ id: "msg-1", segments: segments.slice(0, 2) }),
    ).toEqual({ name: "阿雅", characterId: "char-aya" });
    expect(lastStorySpeaker({ id: "msg-1", segments: [] })).toBeUndefined();
    expect(lastStorySpeaker(undefined)).toBeUndefined();
  });
});

describe("stage paragraph presentation", () => {
  it("attributes complete paragraphs only when segment boundaries match", () => {
    const names = ["Mio", "Rin", null];
    expect(stageParagraphSpeakerName(names, "First", 0)).toBeUndefined();
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond\n\nNarration", 1),
    ).toBe("Rin");
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond\n\nNarration", 2),
    ).toBeUndefined();
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond", 0),
    ).toBeUndefined();
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond\n\nThird\n\nFourth", 0),
    ).toBeUndefined();
  });

  it("uses the same CRLF and repeated-newline boundaries as the typewriter", () => {
    expect(splitStageParagraphs("First\r\n\r\nSecond\n\n\nNarration")).toEqual([
      "First",
      "Second",
      "Narration",
    ]);
  });
});
