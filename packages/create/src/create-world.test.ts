import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
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

const WORLD_PACKAGE_YAML = `characters:
  - schemaVersion: 1
    id: bell-keeper
    name: 守钟人
    role: npc
    description: 唯一记得真实时间的人。
    attributes: { faction: 钟表公会, location: 中央钟楼 }
  - schemaVersion: 1
    id: rain-courier
    name: 雨信使
    role: companion
    description: 在倒转的街巷间递送密信。
    attributes: { faction: 无, location: 南街 }
  - schemaVersion: 1
    id: minute-thief
    name: 窃分者
    role: npc
    description: 正在偷走全城最后一小时。
    attributes: { faction: 逆针会, location: 地下机芯 }
lorebook:
  - { id: central-tower, content: 中央钟楼控制全城时间。, strategy: selective, keys: [钟楼, 时间] }
  - { id: rain-streets, content: 雨水会显出被删除的街道。, strategy: selective, keys: [雨, 街道] }
  - { id: clock-guild-fact, content: 钟表公会垄断校时权。, strategy: selective, keys: [公会, 校时] }
  - { id: reverse-hour, content: 倒转之时会让记忆先于事件消失。, strategy: constant }
rules:
  - { id: time-cost, content: 每次改写时间都必须失去一段等长记忆。, strategy: constant }
  - { id: rain-reveals, content: 被时间删除的痕迹只能在雨中出现。, strategy: constant }
  - { id: clocks-disagree, content: 不同阵营的钟永远显示不同时间。, strategy: constant }`;

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

  it("writes an exact canonical locale lore variant without crossing scripts", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "繁體世界",
      locale: "zh_hant_tw",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(result.files).toContain("test-world/WORLD.zh-Hant-TW.md");
    expect(result.files).toContain("test-world/WORLD.md");
    expect(result.files).not.toContain("test-world/WORLD.zh.md");
    await expect(
      access(path.join(tmp, "test-world", "WORLD.zh-Hant-TW.md")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(tmp, "test-world", "WORLD.zh.md")),
    ).rejects.toThrow();
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

  it("writes requested portable world-package supplements", async () => {
    const enrichedYaml = WORLD_YAML.replace(
      "    openingScenario: 雨夜里，钟楼提前敲响，玩家必须选择追踪钟声或保护证人。",
      `    openingScenario: 雨夜里，钟楼提前敲响，玩家必须选择追踪钟声或保护证人。
    openingChips: [追踪钟声, 保护证人, 封锁钟楼]
    startingResources:
      铜分: 8
      防水火柴: 2`,
    ).concat(`
memoryBlocks:
  - label: time_debt
    displayName: 时间债
    extractionHint: 玩家改写时间付出的记忆与后果。
  - label: erased_clues
    displayName: 被删除的线索
    extractionHint: 只在雨中显现、随后可能再次消失的证据。
`);
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${enrichedYaml}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`,
      ),
      concept: "雨中的倒转钟城",
      outputDir: tmp,
      attemptTimeoutMs: 5_000,
      brief: {
        experienceMode: "dialogue-mode",
        content: ["characters", "lorebook", "rules", "memory", "opening-kit"],
        additionalInstructions: "让角色彼此隐瞒一段共同历史。",
      },
    });

    expect(result.success).toBe(true);
    expect(result.packageContent).toMatchObject({
      characters: expect.arrayContaining([
        expect.objectContaining({ id: "bell-keeper", name: "守钟人" }),
      ]),
      lorebook: expect.arrayContaining([
        expect.objectContaining({ id: "central-tower" }),
      ]),
      rules: expect.arrayContaining([
        expect.objectContaining({ id: "time-cost" }),
      ]),
    });
    const manifest = await readFile(
      path.join(tmp, "test-world", "world.yaml"),
      "utf8",
    );
    const descriptor = await readFile(
      path.join(tmp, "test-world", "data/world.data.yaml"),
      "utf8",
    );
    const characters = JSON.parse(
      await readFile(
        path.join(tmp, "test-world", "characters/main-cast.json"),
        "utf8",
      ),
    ) as unknown[];
    const lorebook = await readFile(
      path.join(tmp, "test-world", "data/lorebook.yaml"),
      "utf8",
    );
    expect(manifest).toContain("preset: dialogue-mode");
    expect(manifest).toContain("defaultViewMode: stage");
    expect(manifest).toContain("characterBlueprintSources:");
    expect(manifest).toContain("memoryBlocks:");
    expect(descriptor).toContain("to: characters");
    expect(descriptor).toContain("to: lorebook");
    expect(characters).toHaveLength(3);
    expect(lorebook).toContain("sourceKind: rule");
  });
});

describe("buildWorldPrompt", () => {
  it("documents lore quality constraints for generated worlds", async () => {
    const prompt = await buildWorldPrompt("低成本快速验证世界", "zh-CN");
    expect(prompt).toContain('Start with exactly one H1: "# <world name>".');
    expect(prompt).toContain(
      "Never expose the generation process or describe world content as a test fixture, prompt/model output, evaluation artifact, or framework implementation example",
    );
    expect(prompt).toContain(
      "Technical vocabulary is allowed when it belongs to the fictional setting",
    );
    expect(prompt).toContain(
      "The openingScenario and all 3 adventure hooks must revolve around the same current crisis or pressure mechanism.",
    );
  });

  it("turns the structured brief into binding package instructions", async () => {
    const prompt = await buildWorldPrompt("雨中的倒转钟城", "zh-CN", {
      experienceMode: "dialogue-mode",
      content: ["characters", "rules"],
      additionalInstructions: "不要使用救世主预言。",
    });
    expect(prompt).toContain("Experience preset: dialogue-mode");
    expect(prompt).toContain("CREATE: 3-5 interconnected main character");
    expect(prompt).toContain("OMIT: 4-8 focused setting entries");
    expect(prompt).toContain("不要使用救世主预言。");
    expect(prompt).toContain("===WORLD_PACKAGE_YAML===");
  });
});
