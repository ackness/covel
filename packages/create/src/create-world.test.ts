import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createWorld } from "./create-world.js";
import { buildWorldPrompt } from "./prompts.js";

const WORLD_YAML = `schemaVersion: "1.0"
id: test-world
name: 测试世界
version: "0.1.0"
summary: 一个用于生成器测试的世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [test]
requiredPlugins: []
recommendedPlugins: []
dimensions:
  geography:
    overview: 小型测试地区。
    regions:
      - name: 中央街区
        description: 所有测试都从这里开始。
        climate: 温和
  factions:
    - id: clock-guild
      name: 钟表公会
      description: 维护城镇时间秩序。
      type: guild
      influence: major
  powerSystem:
    name: 分针术
    type: magic
    description: 通过时间刻度施法。
    rules: [每次施法都会留下刻痕]
  history:
    - name: 第一次倒转
      description: 城镇钟楼首次倒转。
      significance: major
  economy:
    currencies:
      - name: 铜分
        symbol: m
  socialStructure:
    classes:
      - name: 守钟人
        description: 负责巡街。
  tone:
    genres: [mystery]
    contentRating: teen
  mechanics:
    combatStyle: narrative
  startingConditions:
    openingScenario: 雨夜里，钟楼提前敲响，玩家必须选择追踪钟声或保护证人。
`;

const WORLD_LORE = `# 测试世界

这是一个足够长的 WORLD.md 内容，用于确认解析器会保留完整的 lore 文档。

## 冒险钩子

1. 钟楼在无人值守时倒转。
2. 公会记录出现不存在的名字。
3. 街区尽头的门只在雨夜打开。`;

class FixedLlm implements LLMAdapter {
  constructor(private readonly content: string) {}

  async generate(): Promise<LLMResponse> {
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class SequenceLlm implements LLMAdapter {
  public calls = 0;

  constructor(private readonly contents: readonly string[]) {}

  async generate(): Promise<LLMResponse> {
    const content =
      this.contents[Math.min(this.calls, this.contents.length - 1)]!;
    this.calls += 1;
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

describe("createWorld", () => {
  let tmp = "";

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "covel-create-world-"));
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("writes full lore when the model includes the end delimiter", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "测试世界",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    const lore = await readFile(
      path.join(tmp, "test-world", "WORLD.md"),
      "utf8",
    );
    expect(lore).toBe(WORLD_LORE);
    const manifest = await readFile(
      path.join(tmp, "test-world", "world.yaml"),
      "utf8",
    );
    const descriptor = await readFile(
      path.join(tmp, "test-world", "data/world.data.yaml"),
      "utf8",
    );
    const dimensions = await readFile(
      path.join(tmp, "test-world", "data/dimensions.yaml"),
      "utf8",
    );
    expect(manifest).toContain("worldData: data/world.data.yaml");
    expect(manifest).not.toContain("dimensionSources:");
    expect(manifest).not.toContain("dimensions:");
    expect(descriptor).toContain("schema: covel://world/dimensions");
    expect(descriptor).toContain("to: world:metadata.dimensions");
    expect(dimensions).toContain("geography:");
  });

  it("writes full lore when the model omits the trailing end delimiter", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}`,
      ),
      concept: "测试世界",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    const lore = await readFile(
      path.join(tmp, "test-world", "WORLD.md"),
      "utf8",
    );
    expect(lore).toBe(WORLD_LORE);
  });

  it("normalizes WORLD.md to an H1 title", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n## 测试世界\n\n正文。\n\n1. 钩子一。\n2. 钩子二。\n3. 钩子三。`,
      ),
      concept: "测试世界",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    const lore = await readFile(
      path.join(tmp, "test-world", "WORLD.md"),
      "utf8",
    );
    expect(lore.startsWith("# 测试世界\n")).toBe(true);
  });

  it("retries when WORLD.md contains meta generation wording", async () => {
    const llm = new SequenceLlm([
      `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n# 测试世界\n\n这是一个低成本快速验证用的世界。\n\n1. 钩子一。\n2. 钩子二。\n3. 钩子三。`,
      `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n# 测试世界\n\n钟楼在雨夜提前敲响，所有街区必须在下一声钟响前选择阵营。\n\n1. 钩子一。\n2. 钩子二。\n3. 钩子三。`,
    ]);

    const result = await createWorld({
      llm,
      concept: "测试世界",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(llm.calls).toBe(2);
    const lore = await readFile(
      path.join(tmp, "test-world", "WORLD.md"),
      "utf8",
    );
    expect(lore).not.toContain("低成本");
    expect(lore).not.toContain("快速验证");
  });

  it("repairs common low-cost model formatting issues before validation", async () => {
    const malformed = `schemaVersion: 1
id: test-world
name: 测试世界
version: 0.1
summary: 一个用于生成器测试的世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [test]
requiredPlugins: []
recommendedPlugins: []
extraRoot: ignored
dimensions:
  factions:
    - id: clock-guild
      name: 钟表公会
      description: 维护城镇时间秩序。
      type: Guild
      influence: Important
  powerSystem:
    name: 分针术
    type: mystic
    description: 通过时间刻度施法。
    rules: [每次施法都会留下刻痕]
  history:
    - name: 第一次倒转
      description: 城镇钟楼首次倒转。
      significance: Critical
  tone:
    genres: [mystery]
    contentRating: TEEN
  mechanics:
    combatStyle: story
    difficulty: ADAPTIVE
  startingConditions:
    openingScenario: 雨夜里，钟楼提前敲响，玩家必须选择追踪钟声或保护证人。
    startingResources:
      铜分: "3"
`;

    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n\`\`\`yaml\n${malformed}\n\`\`\`\n===WORLD_MD===\n${WORLD_LORE}`,
      ),
      concept: "测试世界",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    const manifest = await readFile(
      path.join(tmp, "test-world", "world.yaml"),
      "utf8",
    );
    const dimensions = await readFile(
      path.join(tmp, "test-world", "data/dimensions.yaml"),
      "utf8",
    );
    expect(manifest).toContain('schemaVersion: "1"');
    expect(manifest).not.toContain("extraRoot:");
    expect(dimensions).toContain("type: guild");
    expect(dimensions).toContain("influence: minor");
    expect(dimensions).toContain("contentRating: teen");
    expect(dimensions).toContain("combatStyle: narrative");
    expect(dimensions).toContain("difficulty: adaptive");
    expect(dimensions).toContain("铜分: 3");
  });
});

describe("buildWorldPrompt", () => {
  it("documents lore quality constraints for generated worlds", () => {
    const prompt = buildWorldPrompt("低成本快速验证世界", "zh-CN");
    expect(prompt).toContain('Start with exactly one H1: "# <world name>".');
    expect(prompt).toContain(
      "Never mention tests, validation, prompts, models, cost, cheapness, speed, e2e, API, or framework internals",
    );
    expect(prompt).toContain(
      "The openingScenario and all 3 adventure hooks must revolve around the same current crisis or pressure mechanism.",
    );
  });
});
