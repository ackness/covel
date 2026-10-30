import { describe, expect, it } from "vitest";
import { createStorySegmentStream } from "../src/agent-loop/story-stream.js";
import { normalizeStoryOutput } from "../src/agent-loop/story-output.js";

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
});
