import { describe, expect, it } from "vitest";
import type { NarrativeDeltaSegment } from "@covel/shared";
import { createStorySegmentStream } from "../src/agent-loop/story-stream.js";
import { normalizeStoryOutput } from "../src/agent-loop/story-output.js";
import { parseFinalOutputEnvelope } from "../src/turn-executor/turn-output-helpers.js";

type Delta = { textDelta: string; reset?: true };

function collect() {
  const deltas: Delta[] = [];
  const stream = createStorySegmentStream(async (delta) => {
    deltas.push({
      textDelta: delta.textDelta,
      ...(delta.reset ? { reset: true as const } : {}),
    });
  });
  const send = (textDelta: string, reset?: true) =>
    stream({
      runtimeId: "story",
      pluginId: "story",
      textDelta,
      ...(reset ? { reset } : {}),
    });
  /** The text a client shows: everything since the last reset. */
  const shown = () => {
    let text = "";
    for (const delta of deltas)
      text = (delta.reset ? "" : text) + delta.textDelta;
    return text;
  };
  return { deltas, send, shown };
}

async function streamIn(json: string, cuts: readonly number[]) {
  const { send, shown, deltas } = collect();
  let start = 0;
  for (const cut of [...cuts, json.length]) {
    await send(json.slice(start, cut));
    start = cut;
  }
  return { shown: shown(), deltas };
}

const story = JSON.stringify({
  segments: [
    { kind: "narration", text: "雨停了。" },
    { kind: "dialogue", speaker: "阿雅", text: "「走吧。」" },
  ],
  cues: { present: ["阿雅"], scene: "旧港" },
});

describe("segment text stream", () => {
  it("forwards only the segment texts, however the JSON is split", async () => {
    for (let cut = 1; cut < story.length; cut++)
      expect((await streamIn(story, [cut])).shown, `cut at ${cut}`).toBe(
        "雨停了。\n\n「走吧。」",
      );
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const cuts = Array.from({ length: 50 }, () =>
      Math.floor(random() * story.length),
    ).sort((a, b) => a - b);
    expect((await streamIn(story, cuts)).shown).toBe("雨停了。\n\n「走吧。」");
    // One character at a time.
    expect(
      (
        await streamIn(
          story,
          Array.from({ length: story.length - 1 }, (_, i) => i + 1),
        )
      ).shown,
    ).toBe("雨停了。\n\n「走吧。」");
  });

  it("decodes escapes and folds blank lines like the committed text", async () => {
    const raw =
      '{"segments":[{"kind":"dialogue","speaker":"Q\\"uote","text":"  \\"Hi\\" \\\\ back\\n\\n\\u4e00 \\ud83d\\ude00  "},' +
      '{"kind":"narration","text":"line\\none"}],"cues":{"mood":"tense"}}';
    const everyChar = Array.from({ length: raw.length - 1 }, (_, i) => i + 1);
    const { shown } = await streamIn(raw, everyChar);
    expect(shown).toBe('"Hi" \\ back\n一 😀\n\nline\none');
    expect(shown).toBe(normalizeStoryOutput(JSON.parse(raw))?.narrativeOutput);
    expect(shown).not.toContain("Q");
    expect(shown).not.toContain("tense");
  });

  it("forwards a reset and starts over; prose passes through unchanged", async () => {
    const { send, deltas, shown } = collect();
    await send('{"segments":[{"kind":"narration","text":"draft');
    await send("", true);
    expect(deltas.at(-1)).toEqual({ textDelta: "", reset: true });
    await send("  The repaired ");
    await send("story.\n\nMore.");
    expect(shown()).toBe("  The repaired story.\n\nMore.");
    expect(deltas.slice(-2)).toEqual([
      { textDelta: "  The repaired " },
      { textDelta: "story.\n\nMore." },
    ]);
  });

  it("replaces the text of a first JSON answer when a second one follows", async () => {
    const { send, shown } = collect();
    await send('{"segments":[{"kind":"narration","text":"first"}]}');
    await send('{"segments":[{"kind":"narration","text":"second"}]}');
    expect(shown()).toBe("second");
  });

  it("streams a JSON answer inside a Markdown fence as its committed text", async () => {
    const everyChar = (raw: string) =>
      Array.from({ length: raw.length - 1 }, (_, i) => i + 1);
    for (const raw of [
      "```json\n" + story + "\n```",
      "```JSON " + story + "```",
      "```\n" + story + "\n```\n",
      "  ```json\n\n" + story + "\n```",
    ]) {
      const committed = normalizeStoryOutput(
        parseFinalOutputEnvelope(raw).output,
      )?.narrativeOutput;
      expect(committed).toBe("雨停了。\n\n「走吧。」");
      const { shown } = await streamIn(raw, everyChar(raw));
      expect(shown, JSON.stringify(raw)).toBe(committed);
      expect((await streamIn(raw, [])).shown).toBe(committed);
    }
  });

  it("passes a fence that does not open JSON through as prose", async () => {
    for (const raw of ["```js\nconst a = 1;", "``inline`` text", "```\nplain"])
      expect(
        (
          await streamIn(
            raw,
            Array.from({ length: raw.length - 1 }, (_, i) => i + 1),
          )
        ).shown,
      ).toBe(raw);
  });
});

type MetaDelta = {
  textDelta: string;
  reset?: true;
  segment?: NarrativeDeltaSegment;
};

function collectWithMeta() {
  const events: MetaDelta[] = [];
  const stream = createStorySegmentStream(async (delta) => {
    events.push({
      textDelta: delta.textDelta,
      ...(delta.reset ? { reset: true as const } : {}),
      ...(delta.segment ? { segment: delta.segment } : {}),
    });
  });
  const send = (textDelta: string, reset?: true) =>
    stream({
      runtimeId: "story",
      pluginId: "story",
      textDelta,
      ...(reset ? { reset } : {}),
    });
  return { events, send };
}

/** What a client keeps: the latest metadata of each paragraph since the last reset. */
function liveMeta(events: readonly MetaDelta[]): NarrativeDeltaSegment[] {
  let list: NarrativeDeltaSegment[] = [];
  for (const event of events) {
    if (event.reset) list = [];
    if (event.segment) list[event.segment.index] = event.segment;
  }
  return list;
}

function shownText(events: readonly MetaDelta[]): string {
  let text = "";
  for (const event of events)
    text = (event.reset ? "" : text) + event.textDelta;
  return text;
}

async function streamMeta(json: string, cuts: readonly number[]) {
  const { send, events } = collectWithMeta();
  let start = 0;
  for (const cut of [...cuts, json.length]) {
    await send(json.slice(start, cut));
    start = cut;
  }
  return events;
}

const everyCut = (raw: string) =>
  Array.from({ length: raw.length - 1 }, (_, i) => i + 1);

describe("segment metadata stream", () => {
  it("attaches each paragraph's kind and speaker to the event with its first character", async () => {
    const raw = JSON.stringify({
      segments: [
        { kind: "narration", text: "雨停了。" },
        { kind: "dialogue", speaker: "小雅", text: "「走吧。」" },
      ],
    });
    expect(await streamMeta(raw, [])).toEqual([
      { textDelta: "雨停了。", segment: { index: 0, kind: "narration" } },
      {
        textDelta: "\n\n「走吧。」",
        segment: { index: 1, kind: "dialogue", speaker: "小雅" },
      },
    ]);
    const events = await streamMeta(raw, everyCut(raw));
    const firsts = events.filter((event) => event.segment);
    expect(firsts).toEqual([
      { textDelta: "雨", segment: { index: 0, kind: "narration" } },
      {
        textDelta: "\n\n「",
        segment: { index: 1, kind: "dialogue", speaker: "小雅" },
      },
    ]);
  });

  it("sends one extra empty event when the speaker follows the text", async () => {
    const raw =
      '{"segments":[{"kind":"dialogue","text":"「走吧。」","speaker":"小雅"}]}';
    expect(await streamMeta(raw, [])).toEqual([
      { textDelta: "「走吧。」", segment: { index: 0, kind: "dialogue" } },
      {
        textDelta: "",
        segment: { index: 0, kind: "dialogue", speaker: "小雅" },
      },
    ]);
    // A speaker before the kind changes nothing until the kind makes the
    // paragraph a dialogue: one update, not two.
    const late =
      '{"segments":[{"text":"Hi.","speaker":"Ana","kind":"dialogue"}]}';
    expect(await streamMeta(late, [])).toEqual([
      { textDelta: "Hi.", segment: { index: 0, kind: "narration" } },
      {
        textDelta: "",
        segment: { index: 0, kind: "dialogue", speaker: "Ana" },
      },
    ]);
  });

  it("ends with the same metadata and text however the JSON is split", async () => {
    const raw = JSON.stringify({
      segments: [
        { kind: "narration", text: "  Rain\n\nstops. " },
        { text: "「走吧。」", speaker: "小雅", kind: "dialogue" },
        { kind: "action", speaker: "Bo\u00e9 \ud83d\ude00", text: "nods" },
        { kind: "dialogue", text: "   " },
        { kind: "dialogue", speaker: " Ana ", text: "Go." },
      ],
      cues: { present: ["小雅"] },
    });
    const whole = await streamMeta(raw, []);
    const expected = liveMeta(whole);
    expect(expected).toEqual([
      { index: 0, kind: "narration" },
      { index: 1, kind: "dialogue", speaker: "小雅" },
      { index: 2, kind: "action", speaker: "Boé 😀" },
      { index: 3, kind: "dialogue", speaker: "Ana" },
    ]);
    const text = shownText(whole);
    for (let cut = 1; cut < raw.length; cut++) {
      const events = await streamMeta(raw, [cut]);
      expect(liveMeta(events), `cut at ${cut}`).toEqual(expected);
      expect(shownText(events), `cut at ${cut}`).toBe(text);
    }
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const cuts = Array.from({ length: 50 }, () =>
      Math.floor(random() * raw.length),
    ).sort((a, b) => a - b);
    const randomEvents = await streamMeta(raw, cuts);
    expect(liveMeta(randomEvents)).toEqual(expected);
    expect(shownText(randomEvents)).toBe(text);
    const everyChar = await streamMeta(raw, everyCut(raw));
    expect(liveMeta(everyChar)).toEqual(expected);
    expect(shownText(everyChar)).toBe(text);
    // One update per later-closing value, and one start per paragraph.
    expect(everyChar.filter((event) => event.segment)).toHaveLength(5);
  });

  it("applies the lenient rules: unknown kinds, empty texts and long speakers", async () => {
    const raw = JSON.stringify({
      segments: [
        { kind: "monologue", speaker: "Ana", text: "One." },
        { kind: "dialogue", speaker: "Ana", text: "  " },
        { kind: "narration", speaker: "Ana", text: "Two." },
        { kind: "dialogue", speaker: ` ${"名".repeat(90)} `, text: "Three." },
      ],
    });
    expect(liveMeta(await streamMeta(raw, everyCut(raw)))).toEqual([
      { index: 0, kind: "narration" },
      { index: 1, kind: "narration" },
      { index: 2, kind: "dialogue", speaker: "名".repeat(80) },
    ]);
  });

  it("clears metadata on a reset and on a second answer; prose carries none", async () => {
    const { send, events } = collectWithMeta();
    await send('{"segments":[{"kind":"dialogue","speaker":"Ana","text":"draft');
    await send("", true);
    expect(events.at(-1)).toEqual({ textDelta: "", reset: true });
    await send('{"segments":[{"kind":"narration","text":"again"}]}');
    expect(liveMeta(events)).toEqual([{ index: 0, kind: "narration" }]);
    await send(
      '{"segments":[{"kind":"dialogue","speaker":"Bo","text":"new"}]}',
    );
    expect(events.at(-1)).toEqual({
      textDelta: "new",
      reset: true,
      segment: { index: 0, kind: "dialogue", speaker: "Bo" },
    });
    expect(liveMeta(events)).toEqual([
      { index: 0, kind: "dialogue", speaker: "Bo" },
    ]);

    const prose = collectWithMeta();
    await prose.send("Plain ");
    await prose.send("story.\n\nMore.");
    expect(prose.events).toEqual([
      { textDelta: "Plain " },
      { textDelta: "story.\n\nMore." },
    ]);
  });

  it("ends with the committed story's kinds and speakers", async () => {
    const fixtures: unknown[] = [
      {
        segments: [
          { kind: "narration", text: "雨停了。" },
          { kind: "dialogue", speaker: "小雅", text: "「走吧。」" },
        ],
      },
      {
        segments: [
          { text: "Late speaker.", speaker: "Ana", kind: "dialogue" },
          { speaker: "Bo", text: "Speaker without kind." },
        ],
      },
      {
        segments: [
          { kind: "chorus", speaker: "All", text: "Unknown kind." },
          { kind: 3, speaker: "Ana", text: "Kind is not a string." },
          { kind: "action", speaker: 7, text: "Speaker is not a string." },
        ],
      },
      {
        segments: [
          { kind: "dialogue", speaker: "Ana", text: "" },
          { kind: "dialogue", speaker: "Ana", text: " \n\n " },
          { kind: "action", speaker: "  ", text: "Blank speaker." },
          { kind: "dialogue", text: 5 },
          { kind: "dialogue", speaker: "Cy", text: "After the gaps." },
        ],
      },
      {
        segments: [
          {
            kind: "dialogue",
            meta: { speaker: "Nested", text: "not a paragraph" },
            speaker: 'Q"uote \\ 😀',
            text: "Escapes.",
          },
          {
            kind: "action",
            speaker: `${"x".repeat(79)}😀😀`,
            text: "Long speaker.",
          },
        ],
        cues: { present: ["Ana"], scene: "Port" },
      },
      {
        segments: Array.from({ length: 60 }, (_, index) => ({
          kind: index % 3 === 0 ? "narration" : "dialogue",
          ...(index % 2 ? { speaker: `Speaker ${index}` } : {}),
          text: `Line ${index}.`,
        })),
      },
    ];
    for (const fixture of fixtures) {
      const raw = JSON.stringify(fixture);
      const committed = normalizeStoryOutput(fixture)?.segments as
        { kind: string; speaker?: string }[] | undefined;
      expect(committed, raw).toBeDefined();
      const live = liveMeta(await streamMeta(raw, everyCut(raw)));
      expect(
        live.map(({ kind, speaker }) => ({
          kind,
          ...(speaker ? { speaker } : {}),
        })),
        raw,
      ).toEqual(
        committed!.map(({ kind, speaker }) => ({
          kind,
          ...(speaker ? { speaker } : {}),
        })),
      );
      expect(live.map((meta) => meta.index)).toEqual(
        committed!.map((_, index) => index),
      );
    }
  });
});
