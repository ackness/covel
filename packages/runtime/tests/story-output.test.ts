import { describe, expect, it } from "vitest";
import {
  normalizeStoryOutput,
  STORY_EMPTY_ERROR,
  storyOutputError,
  storyOutputProblems,
} from "../src/agent-loop/story-output.js";
import { sanitizeStoryNarrativeText } from "../src/turn-executor/turn-output-helpers.js";

describe("story normalization", () => {
  it.each([
    "雨停了。",
    "雨停了。\n\n她转身离开。",
    "  The lamp flickers.  \n\n\n\nA door opens.\nSomeone waits.  ",
    "第一段。\n \n仍是第一段。\n\n第二段。",
    "她看着你。\n\n**你会怎么做？**",
  ])("keeps a prose story's text byte for byte (%#)", (prose) => {
    const story = normalizeStoryOutput({ narrativeOutput: prose });
    expect(story?.narrativeOutput).toBe(sanitizeStoryNarrativeText(prose));
    expect(
      (story!.segments as { kind: string }[]).every(
        (segment) => segment.kind === "narration",
      ),
    ).toBe(true);
  });

  it("joins segment texts, overwrites the written text and keeps business fields", () => {
    const written = {
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "dialogue", speaker: "阿雅", text: "「走吧。」\n\n她转身。" },
      ],
      narrativeOutput: "the model's own copy",
      events: [{ name: "rain-stopped" }],
    };
    const story = normalizeStoryOutput(written);
    expect(story).toEqual({
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "dialogue", speaker: "阿雅", text: "「走吧。」\n她转身。" },
      ],
      events: [{ name: "rain-stopped" }],
      yield: "user",
      narrativeOutput: "雨停了。\n\n「走吧。」\n她转身。",
    });
    expect(normalizeStoryOutput(story)).toEqual(story);
  });

  it("reads leniently: unknown kinds narrate, narration loses its speaker, empty segments go", () => {
    expect(
      normalizeStoryOutput({
        segments: [
          { kind: "monologue", text: "风声。" },
          { kind: "narration", speaker: "阿雅", text: "门开了。" },
          { kind: "dialogue", text: "「谁？」" },
          { kind: "action", speaker: "陈远", text: "  " },
        ],
        cues: { present: ["陈远", " ", "陈远"], scene: "", mood: "紧张" },
        yield: "continue",
      }),
    ).toMatchObject({
      segments: [
        { kind: "narration", text: "风声。" },
        { kind: "narration", text: "门开了。" },
        { kind: "dialogue", text: "「谁？」" },
      ],
      cues: { present: ["陈远"], mood: "紧张" },
      yield: "continue",
    });
  });

  it("keeps a long story inside the segment limits", () => {
    const long = normalizeStoryOutput({
      segments: [
        {
          kind: "narration",
          text: `${"甲".repeat(3000)}\n${"乙".repeat(3000)}`,
        },
      ],
    });
    expect(long?.segments).toEqual([
      { kind: "narration", text: "甲".repeat(3000) },
      { kind: "narration", text: "乙".repeat(3000) },
    ]);
    const many = normalizeStoryOutput({
      narrativeOutput: Array.from({ length: 70 }, (_, i) => `第${i}段。`).join(
        "\n\n",
      ),
    });
    expect((many!.segments as unknown[]).length).toBeLessThanOrEqual(60);
    expect(many?.narrativeOutput).toContain("第69段。");
  });

  it("fails only when no text is left", () => {
    expect(normalizeStoryOutput({ segments: [] })).toBeUndefined();
    expect(normalizeStoryOutput({ narrativeOutput: " " })).toBeUndefined();
    expect(
      normalizeStoryOutput({ segments: [{ kind: "narration", text: "\n" }] }),
    ).toBeUndefined();
    expect(normalizeStoryOutput(null)).toBeUndefined();
  });
});

describe("strict story problems", () => {
  const options = { segmentsRequired: true, prose: false };
  const characterId = "char-7f3a";

  it("names each structural problem by position, with no IDs", () => {
    expect(
      storyOutputProblems(
        {
          segments: [
            { kind: "dialogue", text: "「走吧。」" },
            { kind: "whisper", speaker: characterId, text: "x" },
          ],
        },
        options,
      ),
    ).toEqual([
      "segment 1 is dialogue without a speaker; name who speaks",
      "segment 2 has an unknown kind; use narration, dialogue or action",
    ]);
    expect(storyOutputProblems({ segments: [] }, options)).toEqual([
      "the segments array is empty; write at least one segment",
    ]);
    expect(
      storyOutputProblems(
        { narrativeOutput: "雨停了。" },
        { segmentsRequired: true, prose: true },
      ),
    ).toEqual([
      "the answer is prose; return a JSON object whose segments array holds the story",
    ]);
    expect(
      storyOutputProblems(
        { narrativeOutput: "雨停了。" },
        { segmentsRequired: false, prose: true },
      ),
    ).toEqual([]);
  });

  it("lists at most five problems of at most 200 characters", () => {
    const problems = storyOutputProblems(
      {
        segments: Array.from({ length: 8 }, () => ({
          kind: "dialogue",
          speaker: characterId.repeat(20),
          text: "",
        })),
      },
      options,
    );
    expect(problems).toHaveLength(5);
    expect(problems.every((problem) => problem.length <= 200)).toBe(true);
    expect(problems.join(" ")).not.toContain(characterId);
  });

  it("reads raw segments for the no-story check", () => {
    expect(
      storyOutputError({ segments: [{ kind: "narration", text: "x" }] }),
    ).toBeUndefined();
    expect(storyOutputError({ narrativeOutput: "雨停了。" })).toBeUndefined();
    expect(storyOutputError({ segments: [] })).toBe(STORY_EMPTY_ERROR);
    expect(storyOutputError({ narrativeOutput: " " })).toBe(STORY_EMPTY_ERROR);
  });
});
