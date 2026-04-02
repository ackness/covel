import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
  createCollectingRegistrar,
  createMockProviderInput,
} from "@covel/plugin-test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import register from "../server/index.js";
import type { NarratorContextSection } from "../server/context-provider.js";

const PLUGIN_MD_PATH = resolve(import.meta.dirname, "../PLUGIN.md");

describe.skipIf(!LIVE)("live: core-narrator", () => {
  it("generates opening narrative with PLUGIN.md instructions (zh-CN)", async () => {
    const generateText = await createLiveGenerateText();
    const instructions = readFileSync(PLUGIN_MD_PATH, "utf-8");

    const prompt = [
      instructions,
      "",
      "## 世界设定",
      '你是一个奇幻世界的叙事者。世界名为\u201C雾隐大陆\u201D\u2014\u2014一片被永恒薄雾笼罩的神秘大陆。',
      "这里有古老的魔法、沉睡的龙族、和被遗忘的文明遗迹。",
      "",
      "## 任务",
      "这是游戏的第一回合（session_start）。请生成2-4段开场叙事。",
    ].join("\n");

    const result = await generateText(prompt);

    expect(result.length).toBeGreaterThan(100);
    // Should use second person as instructed
    expect(result).toMatch(/你/);
  }, 60_000);

  it("generates opening narrative with PLUGIN.md instructions (en-US)", async () => {
    const generateText = await createLiveGenerateText();
    const instructions = readFileSync(PLUGIN_MD_PATH, "utf-8");

    const prompt = [
      instructions,
      "",
      "## World Setting",
      "You are the narrator for a fantasy world called 'The Veiled Continent'",
      "— a mysterious land shrouded in eternal mist, with ancient magic,",
      "sleeping dragons, and forgotten ruins.",
      "",
      "## Task",
      "This is the first turn (session_start). Generate a 2-4 paragraph opening scene.",
    ].join("\n");

    const result = await generateText(prompt);

    expect(result.length).toBeGreaterThan(100);
    // Should use second person as instructed (English or Chinese model may respond in either language)
    expect(result).toMatch(/you|You|your|Your|你/i);
  }, 60_000);

  it("continues story from player input", async () => {
    const generateText = await createLiveGenerateText();
    const instructions = readFileSync(PLUGIN_MD_PATH, "utf-8");

    const prompt = [
      instructions,
      "",
      "## 世界设定",
      "雾隐大陆，一个被薄雾笼罩的奇幻世界。",
      "",
      "## 之前的叙事",
      "你站在雾隐大陆边缘的悬崖上，脚下是深不见底的迷雾峡谷。",
      "远处传来低沉的号角声，似乎在召唤着什么。",
      "",
      "## 玩家输入",
      "我沿着悬崖边的小路向号角声的方向走去。",
      "",
      "## 任务",
      "根据玩家的行动继续叙事。",
    ].join("\n");

    const result = await generateText(prompt);

    expect(result.length).toBeGreaterThan(50);
    expect(result).toMatch(/你/);
  }, 60_000);

  it("context provider works correctly alongside live narrative", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    const provider = contributions.contextProviders.get("narrator-context")!;

    const input = createMockProviderInput({
      state: {
        narratorState: {
          lastNarrative: "勇者踏上了通往冰霜要塞的道路，寒风刺骨。",
          tone: "冷峻而危险",
        },
      },
      world: {
        name: "雾隐大陆",
        description: "一片被永恒薄雾笼罩的神秘大陆",
      },
      locale: "zh-CN",
    });

    const result = (await provider(input)) as NarratorContextSection;

    expect(result).not.toBeNull();
    expect(result.title).toBe("Narrator Context");
    expect(result.content).toContain("一片被永恒薄雾笼罩的神秘大陆");
    expect(result.content).toContain("冷峻而危险");
    expect(result.content).toContain("勇者踏上了通往冰霜要塞的道路");
  });
});
