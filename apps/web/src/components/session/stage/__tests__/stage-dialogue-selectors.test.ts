import { describe, expect, it } from "vitest";
import {
  resolveStageParagraphSpeakers,
  splitStageParagraphs,
  stageParagraphSpeakerName,
} from "../stage-dialogue-selectors.js";

const base = {
  turnId: "turn-2",
  record: undefined,
  speakers: [
    { id: "mio", name: "Mio" },
    { id: "rin", name: "Rin" },
  ],
  presence: {},
  isStreaming: false,
} as const;
const record = {
  schemaVersion: 1,
  turnId: "turn-2",
  paragraphSpeakers: [
    { characterId: "mio", displayName: "Mio" },
    { characterId: "rin", displayName: "Rin" },
    null,
  ],
};

describe("stage paragraph attribution", () => {
  it("restores explicit speakers without requiring the original actors or art", () => {
    expect(
      resolveStageParagraphSpeakers({ ...base, record, speakers: [] }),
    ).toEqual(["Mio", "Rin", null]);
  });

  it("leaves legacy messages, invalid rows, and another turn unattributed", () => {
    expect(resolveStageParagraphSpeakers(base)).toBeUndefined();
    expect(
      resolveStageParagraphSpeakers({ ...base, record, turnId: "turn-3" }),
    ).toBeUndefined();
    expect(
      resolveStageParagraphSpeakers({
        ...base,
        record: { ...record, paragraphSpeakers: ["Mio"] },
      }),
    ).toBeUndefined();
  });

  it("uses the current event while streaming and never reuses a retry's old mapping", () => {
    expect(
      resolveStageParagraphSpeakers({ ...base, record, isStreaming: true }),
    ).toBeUndefined();
    expect(
      resolveStageParagraphSpeakers({
        ...base,
        record,
        isStreaming: true,
        preview: {
          topic: "stage.direction",
          turnId: "turn-2",
          data: {
            cues: [],
            dialogue: { paragraphSpeakers: ["rin", null, "Mio"] },
          },
        },
      }),
    ).toEqual(["Rin", null, null]);
    expect(
      resolveStageParagraphSpeakers({
        ...base,
        record,
        preview: {
          topic: "stage.direction",
          turnId: "turn-2",
          data: { cues: [] },
        },
      }),
    ).toBeUndefined();
  });

  it("attributes streaming paragraphs, then drops the whole map if final boundaries disagree", () => {
    const names = ["Mio", "Rin", null];
    expect(stageParagraphSpeakerName(names, "First", 0, false)).toBe("Mio");
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond\n\nNarration", 1, true),
    ).toBe("Rin");
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond\n\nNarration", 2, true),
    ).toBeUndefined();
    expect(
      stageParagraphSpeakerName(names, "First\n\nSecond", 0, true),
    ).toBeUndefined();
    expect(
      stageParagraphSpeakerName(
        names,
        "First\n\nSecond\n\nThird\n\nFourth",
        0,
        false,
      ),
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
