// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  splitStageParagraphs,
  stageParagraphSpeakerName,
} from "../stage-dialogue-selectors.js";
describe("stage paragraph presentation", () => {
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
