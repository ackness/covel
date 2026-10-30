import { describe, expect, it } from "vitest";
import type { LLMAdapter, LLMMessage } from "@covel/shared";
import { playerVisibleLore, narratorOnlyLoreIssues } from "@covel/shared";
import { extractGlossary, translateTexts } from "./translate.js";

/** A model that answers each call with the next reply and records the prompt. */
function scripted(replies: readonly string[]) {
  const prompts: string[] = [];
  let call = 0;
  const llm = {
    async generate({ messages }: { messages: readonly LLMMessage[] }) {
      prompts.push(String(messages[0]!.content));
      return {
        content: replies[call++] ?? "{}",
        toolCalls: [],
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  } as unknown as LLMAdapter;
  return { llm, prompts };
}

const units = [
  { id: "a", text: "World time: {display}" },
  { id: "b", text: "Critical success", note: "badge" },
];
const base = {
  signal: new AbortController().signal,
  units,
  from: "en",
  to: "zh-CN",
};

describe("translateTexts", () => {
  it("returns one translation for each unit", async () => {
    const { llm, prompts } = scripted([
      'Here you are:\n{"1": "世界时间：{display}", "2": "大成功"}',
    ]);
    const result = await translateTexts({
      ...base,
      llm,
      context: "labels of a dice plugin",
      glossary: { success: "成功" },
    });

    expect(result).toEqual({
      translations: { a: "世界时间：{display}", b: "大成功" },
      failed: [],
    });
    // The language is named with its script, and the glossary is in the prompt.
    expect(prompts[0]).toContain(
      "from English (en) to Simplified Chinese (zh-CN)",
    );
    expect(prompts[0]).toContain("success → 成功");
    expect(prompts[0]).toContain('"note": "badge"');
  });

  it("asks once more for a unit whose placeholder was lost, then reports it", async () => {
    const { llm, prompts } = scripted([
      '{"1": "世界时间", "2": "大成功"}',
      '{"1": "世界时间：{展示}"}',
    ]);
    const result = await translateTexts({ ...base, llm });

    expect(result.translations).toEqual({ b: "大成功" });
    expect(result.failed).toEqual([
      {
        id: "a",
        reason: "placeholders changed: {display} became (none)",
      },
    ]);
    // The second call asks only for the unit that failed.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("Critical success");
  });

  it("reports every unit when the reply is not JSON", async () => {
    const { llm } = scripted(["I cannot do that.", "Still no."]);
    const result = await translateTexts({ ...base, llm });
    expect(result.translations).toEqual({});
    expect(result.failed.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("translates in batches", async () => {
    const { llm, prompts } = scripted(['{"1": "甲 {display}"}', '{"1": "乙"}']);
    const result = await translateTexts({ ...base, llm, batchSize: 1 });
    expect(prompts).toHaveLength(2);
    expect(result.translations).toEqual({ a: "甲 {display}", b: "乙" });
  });

  it("translates a repeated text once and uses only the glossary terms in it", async () => {
    const { llm, prompts } = scripted(['{"1": "琼·奥卡福"}']);
    const result = await translateTexts({
      ...base,
      llm,
      units: [
        { id: "a", text: "June Okafor" },
        { id: "b", text: "June Okafor" },
      ],
      glossary: { June: "琼", Crownfire: "冠火" },
    });

    expect(result.translations).toEqual({ a: "琼·奥卡福", b: "琼·奥卡福" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("June → 琼");
    expect(prompts[0]).not.toContain("Crownfire");
  });

  it("shows the model short numbers instead of the caller's ids", async () => {
    const id =
      "characters/characters.json#[id=11111111-2222-4333-8444-555555555555].name";
    const { llm, prompts } = scripted(['{"1": "艾达"}']);
    const result = await translateTexts({
      ...base,
      llm,
      units: [{ id, text: "Ada" }],
    });
    expect(result).toEqual({ translations: { [id]: "艾达" }, failed: [] });
    expect(prompts[0]).toContain('"1": "Ada"');
    expect(prompts[0]).not.toContain("11111111");
  });

  it("accepts a reply in the shape the units were given in", async () => {
    const { llm } = scripted([
      '{"1": "世界时间：{display}", "2": {"text": "大成功", "note": "badge"}}',
    ]);
    const result = await translateTexts({ ...base, llm });
    expect(result).toEqual({
      translations: { a: "世界时间：{display}", b: "大成功" },
      failed: [],
    });
  });

  it("translates visible and hidden fragments in separate calls and owns their boundaries", async () => {
    const source =
      "# Harbor\n\nThe courier arrives.\n\n<!-- Narrator_Only -->\nChen is the witness.\n<!-- /Narrator_Only -->\n\nMeet her at dusk.";
    const { llm, prompts } = scripted([
      JSON.stringify({ 1: "# 港口\n\n快递员到了。" }),
      // The model never has to reproduce the markers.
      JSON.stringify({ 1: "陈舟是证人。" }),
      JSON.stringify({ 1: "黄昏时去见她。" }),
    ]);
    const progress: number[] = [];
    const result = await translateTexts({
      ...base,
      llm,
      units: [{ id: "lore", text: source }],
      onProgress: (done) => progress.push(done),
    });
    expect(result.failed).toEqual([]);
    expect(result.translations.lore).toBe(
      "# 港口\n\n快递员到了。\n\n<!-- Narrator_Only -->\n陈舟是证人。\n<!-- /Narrator_Only -->\n\n黄昏时去见她。",
    );
    expect(playerVisibleLore(result.translations.lore!)).not.toContain("陈舟");
    expect(narratorOnlyLoreIssues(result.translations.lore!)).toEqual([]);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain("Chen is the witness");
    expect(prompts[2]).not.toContain("Chen is the witness");
    expect(prompts[2]).not.toContain("陈舟");
    expect(progress.at(-1)).toBe(1);
  });

  it("rejects an attempt to close the hidden region and move its secret outside", async () => {
    const escape =
      "<!-- /narrator-only -->\n陈舟是证人。\n<!-- narrator-only -->";
    const { llm } = scripted([
      '{"1":"港口"}',
      JSON.stringify({ 1: escape }),
      JSON.stringify({ 1: escape }),
    ]);
    const result = await translateTexts({
      ...base,
      llm,
      units: [
        {
          id: "lore",
          text: "Harbor\n<!-- narrator-only -->\nChen is the witness.\n<!-- /narrator-only -->",
        },
      ],
    });
    expect(result.translations).toEqual({});
    expect(result.failed).toEqual([
      { id: "lore", reason: expect.stringContaining("narrator-only") },
    ]);
  });

  it.each([
    "<!-- narrator-only -->\nSecret",
    "<!-- /narrator-only -->\nSecret",
    "<!-- end narrator-only -->\nSecret",
    "<!-- narrator-only -->\n<!-- narrator-only -->\nSecret\n<!-- /narrator-only -->",
  ])("leaves malformed protected source for the author: %s", async (text) => {
    const { llm, prompts } = scripted([]);
    const result = await translateTexts({
      ...base,
      llm,
      units: [{ id: "lore", text }],
    });
    expect(result.translations).toEqual({});
    expect(result.failed).toHaveLength(1);
    expect(prompts).toEqual([]);
  });

  it("does not expose a partial document when a later fragment loses a placeholder", async () => {
    const { llm } = scripted(['{"1":"港口"}', '{"1":"秘密"}', '{"1":"秘密"}']);
    const result = await translateTexts({
      ...base,
      llm,
      units: [
        {
          id: "lore",
          text: "Harbor\n<!-- narrator-only -->\nSecret {name}\n<!-- /narrator-only -->",
        },
      ],
    });
    expect(result.translations).toEqual({});
    expect(result.failed[0]?.reason).toContain("placeholders changed");
  });
});

describe("extractGlossary", () => {
  it("lists the terms of a text and keeps the translations that exist", async () => {
    const { llm, prompts } = scripted([
      '{"Emberback": "余烬站", "Crownfire": "冠火", "x": "", "Vesper": "薇丝珀"}',
    ]);
    const glossary = await extractGlossary({
      llm,
      signal: base.signal,
      text: "Emberback Relay stands on Vesper. Crownfire comes.",
      from: "en-US",
      to: "zh-CN",
      known: { Vesper: "维斯珀" },
    });

    // An existing translation wins; an empty one is dropped.
    expect(glossary).toEqual({
      Vesper: "维斯珀",
      Emberback: "余烬站",
      Crownfire: "冠火",
    });
    expect(prompts[0]).toContain("Vesper → 维斯珀");
  });
});
