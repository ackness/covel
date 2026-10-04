import { describe, expect, it } from "vitest";
import type { LLMAdapter, LLMMessage } from "@covel/shared";
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
      'Here you are:\n{"a": "世界时间：{display}", "b": "大成功"}',
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
      '{"a": "世界时间", "b": "大成功"}',
      '{"a": "世界时间：{展示}"}',
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
    const { llm, prompts } = scripted(['{"a": "甲 {display}"}', '{"b": "乙"}']);
    const result = await translateTexts({ ...base, llm, batchSize: 1 });
    expect(prompts).toHaveLength(2);
    expect(result.translations).toEqual({ a: "甲 {display}", b: "乙" });
  });

  it("translates a repeated text once and uses only the glossary terms in it", async () => {
    const { llm, prompts } = scripted(['{"a": "琼·奥卡福"}']);
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

  it("accepts a reply in the shape the units were given in", async () => {
    const { llm } = scripted([
      '{"a": "世界时间：{display}", "b": {"text": "大成功", "note": "badge"}}',
    ]);
    const result = await translateTexts({ ...base, llm });
    expect(result).toEqual({
      translations: { a: "世界时间：{display}", b: "大成功" },
      failed: [],
    });
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
