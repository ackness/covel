import { describe, expect, it } from "vitest";
import {
  DisplayStreamParser,
  displayUnitsOf,
  type OutputDisplaySpec,
} from "../src/output-draft/display-parser.js";

const segmentsSpec: OutputDisplaySpec = {
  units: "/segments",
  text: "text",
  meta: ["kind", "speaker"],
};

const story = {
  cues: { scene: "雨后的巷子", present: ["阿雅"] },
  segments: [
    { kind: "narration", text: "雨停了。\n街灯亮起。" },
    {
      kind: "dialogue",
      speaker: "阿雅",
      text: '她说："走吧。" \\ 😀',
      extra: [1, { deep: "x" }],
    },
    { text: "Late meta.", kind: "action", speaker: "Ren" },
  ],
  yield: "user",
};

function streamed(document: string, size: number, spec: OutputDisplaySpec) {
  const parser = new DisplayStreamParser(spec);
  const partials: string[] = [];
  for (let index = 0; index < document.length; index += size) {
    parser.push(document.slice(index, index + size));
    const partial = parser.partialUnit();
    if (partial) partials.push(partial.text);
  }
  return { parser, partials };
}

describe("DisplayStreamParser", () => {
  it.each([1, 2, 3, 7, 1000])(
    "reads the same units however the document is split (%i)",
    (size) => {
      const document = JSON.stringify(story, null, size % 2 ? 0 : 2);
      const { parser } = streamed(document, size, segmentsSpec);
      expect(parser.failed).toBe(false);
      expect(parser.completeUnits()).toEqual(
        displayUnitsOf(story, segmentsSpec),
      );
      expect(parser.completeUnits()).toEqual([
        { text: "雨停了。\n街灯亮起。", meta: { kind: "narration" } },
        {
          text: '她说："走吧。" \\ 😀',
          meta: { kind: "dialogue", speaker: "阿雅" },
        },
        { text: "Late meta.", meta: { kind: "action", speaker: "Ren" } },
      ]);
    },
  );

  it("shows a unit's text growing and never half a character", () => {
    // 😀 is one emoji written as an escaped surrogate pair.
    const document =
      '{"segments":[{"kind":"dialogue","text":"ab\\ud83d\\ude00c"}]}';
    const { partials, parser } = streamed(document, 1, segmentsSpec);
    expect(new Set(partials)).toEqual(new Set(["a", "ab", "ab😀", "ab😀c"]));
    expect(parser.completeUnits()).toEqual([
      { text: "ab😀c", meta: { kind: "dialogue" } },
    ]);
  });

  it("keeps a unit open until its object closes, so late fields arrive", () => {
    const parser = new DisplayStreamParser(segmentsSpec);
    parser.push('{"segments":[{"text":"Hi","kind":"dialogue"');
    expect(parser.completeUnits()).toEqual([]);
    expect(parser.partialUnit()).toEqual({
      text: "Hi",
      meta: { kind: "dialogue" },
    });
    parser.push(',"speaker":"Aya"}');
    expect(parser.completeUnits()).toEqual([
      { text: "Hi", meta: { kind: "dialogue", speaker: "Aya" } },
    ]);
    expect(parser.partialUnit()).toBeUndefined();
  });

  it("reads one string as a single unit", () => {
    const spec = { units: "/narrativeOutput" };
    const { parser, partials } = streamed(
      '{"completion":"done","narrativeOutput":"Line one.\\nLine two."}',
      4,
      spec,
    );
    expect(partials.at(-1)).toBe("Line one.\nLine two.");
    expect(parser.completeUnits()).toEqual([{ text: "Line one.\nLine two." }]);
  });

  it("reads an array of strings", () => {
    const spec = { units: "/lines" };
    const { parser } = streamed('{"lines":["a",{"x":1},"b"]}', 1, spec);
    expect(parser.completeUnits()).toEqual([{ text: "a" }]);
    expect(displayUnitsOf({ lines: ["a", { x: 1 }, "b"] }, spec)).toEqual([
      { text: "a" },
      { text: "b" },
    ]);
  });

  it("ignores same-named fields outside the declared place", () => {
    const { parser } = streamed(
      '{"other":{"segments":[{"text":"no"}]},"segments":[{"text":"yes"}]}',
      5,
      { units: "/segments", text: "text" },
    );
    expect(parser.completeUnits()).toEqual([{ text: "yes" }]);
  });

  it("stops at text that is not JSON and keeps what it had", () => {
    const parser = new DisplayStreamParser(segmentsSpec);
    parser.push('{"segments":[{"text":"ok"},');
    parser.push("]}");
    expect(parser.failed).toBe(true);
    expect(parser.completeUnits()).toEqual([{ text: "ok" }]);
  });

  it("starts over from a replacement document", () => {
    const parser = new DisplayStreamParser(segmentsSpec);
    parser.push('{"segments":[{"text":"draft"}');
    parser.replace('{"segments":[{"text":"final"}]}');
    expect(parser.completeUnits()).toEqual([{ text: "final" }]);
  });
});
