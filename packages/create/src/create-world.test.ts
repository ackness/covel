import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LLMAdapter,
  LLMResponse,
  WorldGenerationPart,
} from "@covel/shared";
import { createWorld } from "./create-world.js";
import { writeWorldPackage } from "./world-writer.js";
import { buildWorldPrompt } from "./prompts.js";

const WORLD_YAML = `schemaVersion: "1.0"
id: test-world
name: 测试世界
version: 0.1.0
summary: 一个用于生成器测试的世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [test]
pluginPolicy:
  requested: []
  recommended: []
dimensions:
  geography:
    name: geography
    schema: {}
    initialValue:
      overview: 小型测试地区。
      regions:
        - name: 中央街区
          description: 所有测试都从这里开始。
          climate: 温和
  factions:
    name: factions
    schema: {}
    initialValue:
      - id: clock-guild
        name: 钟表公会
        description: 维护城镇时间秩序。
        type: guild
        influence: major
  powerSystem:
    name: powerSystem
    schema: {}
    initialValue:
      name: 分针术
      type: magic
      description: 通过时间刻度施法。
      rules:
        - 每次施法都会留下刻痕
  history:
    name: history
    schema: {}
    initialValue:
      - name: 第一次倒转
        description: 城镇钟楼首次倒转。
        significance: major
  economy:
    name: economy
    schema: {}
    initialValue:
      currencies:
        - name: 铜分
          symbol: m
  socialStructure:
    name: socialStructure
    schema: {}
    initialValue:
      classes:
        - name: 守钟人
          description: 负责巡街。
  tone:
    name: tone
    schema: {}
    initialValue:
      genres:
        - mystery
      contentRating: teen
  mechanics:
    name: mechanics
    schema: {}
    initialValue:
      combatStyle: narrative
  startingConditions:
    name: startingConditions
    schema: {}
    initialValue:
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

  it("returns portable content without writes and exports without mutating it", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "Clockwork city",
    });
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(await readdir(tmp)).toEqual([]);
    expect(result.manifest.dimensions).toHaveProperty("geography");
    expect(result.lore).toBe(WORLD_LORE);
    const original = structuredClone(result);
    Object.freeze(result.manifest);
    await writeWorldPackage(tmp, result);
    expect(result).toEqual(original);
    await expect(
      writeWorldPackage(tmp, { ...result, id: "../escaped" }),
    ).rejects.toThrow("invalid generated world");
  });

  it("returns the validated manifest with canonical locales and schema defaults", async () => {
    const yaml = WORLD_YAML.replace(
      "defaultLocale: zh-CN",
      "defaultLocale: zh_hant_tw",
    )
      .replace(
        "supportedLocales: [zh-CN]",
        "supportedLocales: [zh_hant_tw, en_us]",
      )
      .replace(
        "tags: [test]",
        "tags: [test]\ncharacterSchema:\n  attributes:\n    - id: affinity\n      name: 关系\n      type: number\n      category: social\npluginSettings:\n  memory:\n    cadence: 2",
      );
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${yaml}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "Clockwork city",
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.manifest).toMatchObject({
      defaultLocale: "zh-Hant-TW",
      supportedLocales: ["zh-Hant-TW", "en-US"],
      characterSchema: {
        types: ["npc", "companion"],
        attributes: [
          { id: "affinity", name: "关系", type: "number", category: "social" },
        ],
      },
      pluginSettings: { memory: { cadence: 2 } },
      dimensions: {
        geography: {
          name: "geography",
          schema: {},
          initialValue: { regions: [{ name: "中央街区" }] },
        },
      },
    });
  });

  it("rejects unresolved file references before returning generated content", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\nworldData: missing.yaml\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "Clockwork city",
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join(" ")).toContain("inline data");
    expect(await readdir(tmp)).toEqual([]);
  });

  it("propagates caller cancellation on the final generation attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("caller canceled final attempt");
    let calls = 0;
    const llm: LLMAdapter = {
      async generate() {
        calls++;
        if (calls === 3) controller.abort(reason);
        throw new Error("provider request failed");
      },
    };

    await expect(
      createWorld({
        llm,
        concept: "Synthetic world",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(3);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("does not ask again after the model stayed silent for the idle timeout", async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      async generate({ signal }) {
        calls++;
        return new Promise<LLMResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };

    const result = await createWorld({
      llm,
      concept: "Synthetic world",
      idleTimeoutMs: 5,
    });
    // The wait is the player's limit: one silent request ends the generation.
    expect(result).toMatchObject({ success: false, idleTimeout: true });
    expect(calls).toBe(1);
  });

  it("finishes the world with the parts it has when the model stops answering", async () => {
    const requests: string[] = [];
    const reports: WorldGenerationPart[][] = [];
    const answer = `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`;
    const result = await createWorld({
      llm: {
        async generate({ messages, signal }) {
          const request = String(messages[1]?.content).split("\n")[0]!;
          requests.push(request);
          if (!request.includes("`lorebook`")) {
            return {
              content: answer,
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          }
          return new Promise<LLMResponse>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      },
      concept: "Clockwork city",
      idleTimeoutMs: 5,
      brief: { content: ["characters", "lorebook", "rules"] },
      onProgress: (parts) => reports.push([...parts]),
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    // The lorebook is asked for once, and the rules are not asked for.
    expect(requests.map((request) => request.split(": ")[1])).toEqual([
      "WORLD_YAML.",
      "WORLD_MD.",
      "the `characters` list of WORLD_PACKAGE_YAML.",
      "the `lorebook` list of WORLD_PACKAGE_YAML.",
    ]);
    expect(result.packageContent.characters).toHaveLength(3);
    expect(result.packageContent.lorebook).toEqual([]);
    expect(result.packageContent.rules).toEqual([]);
    expect(result.warnings).toEqual([
      "lorebook could not be generated: LLM error: The model sent no output for 0.005 seconds",
      "rules was not requested: the model stopped answering",
    ]);
    expect(reports.at(-1)!.map((part) => [part.id, part.state])).toEqual([
      ["manifest", "done"],
      ["lore", "done"],
      ["characters", "done"],
      ["lorebook", "failed"],
      ["rules", "failed"],
    ]);
  });

  it("writes a new world one part at a time and reports each part", async () => {
    const requests: string[] = [];
    const reports: WorldGenerationPart[][] = [];
    const answer = `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`;
    const result = await createWorld({
      llm: {
        async generate({ messages }) {
          requests.push(String(messages[1]?.content).split("\n")[0]!);
          return {
            content: answer,
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      concept: "Clockwork city",
      brief: { content: ["characters", "lorebook", "rules"] },
      onProgress: (parts) => reports.push([...parts]),
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(requests).toEqual([
      "Write one part of the world package now: WORLD_YAML.",
      "Write one part of the world package now: WORLD_MD.",
      "Write one part of the world package now: the `characters` list of WORLD_PACKAGE_YAML.",
      "Write one part of the world package now: the `lorebook` list of WORLD_PACKAGE_YAML.",
      "Write one part of the world package now: the `rules` list of WORLD_PACKAGE_YAML.",
    ]);
    // Every part is known before the first request, and ends as done.
    expect(reports[0]!.map((part) => [part.id, part.state])).toEqual([
      ["manifest", "pending"],
      ["lore", "pending"],
      ["characters", "pending"],
      ["lorebook", "pending"],
      ["rules", "pending"],
    ]);
    expect(reports.at(-1)!.map((part) => part.state)).toEqual(
      Array.from({ length: 5 }, () => "done"),
    );
    // While the lore is written the manifest is done and the lists wait.
    const duringLore = reports.find((parts) => parts[1]!.state === "active")!;
    expect(duringLore.map((part) => part.state)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("keeps the world when one supplement cannot be generated", async () => {
    const requests: string[] = [];
    const reports: WorldGenerationPart[][] = [];
    const answer = `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`;
    const result = await createWorld({
      llm: {
        async generate({ messages }) {
          const request = String(messages[1]?.content).split("\n")[0]!;
          requests.push(request);
          return {
            content: request.includes("`characters`")
              ? "===WORLD_PACKAGE_YAML===\ncharacters: []\n===END==="
              : answer,
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      },
      concept: "Clockwork city",
      brief: { content: ["characters", "lorebook"] },
      onProgress: (parts) => reports.push([...parts]),
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    // The manifest and the lore are requested once; only the cast is asked
    // for again, and the lorebook still follows.
    expect(requests.map((request) => request.split(": ")[1])).toEqual([
      "WORLD_YAML.",
      "WORLD_MD.",
      "the `characters` list of WORLD_PACKAGE_YAML.",
      "the `characters` list of WORLD_PACKAGE_YAML.",
      "the `characters` list of WORLD_PACKAGE_YAML.",
      "the `lorebook` list of WORLD_PACKAGE_YAML.",
    ]);
    expect(result.packageContent.characters).toEqual([]);
    expect(result.packageContent.lorebook).toHaveLength(4);
    expect(result.warnings).toContain(
      "characters could not be generated: WORLD_PACKAGE_YAML must include characters",
    );
    expect(reports.at(-1)!.map((part) => [part.id, part.state])).toEqual([
      ["manifest", "done"],
      ["lore", "done"],
      ["characters", "failed"],
      ["lorebook", "done"],
    ]);
  });

  it("gives a rule another id when a lorebook entry has taken it", async () => {
    const pack = `lorebook:
  - { id: time-cost, content: 钟楼控制全城时间。, strategy: constant }
rules:
  - { id: time-cost, content: 每次改写时间都要失去记忆。, strategy: constant }`;
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${pack}\n===END===`,
      ),
      concept: "Clockwork city",
      brief: { content: ["lorebook", "rules"] },
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.packageContent.lorebook.map((item) => item.id)).toEqual([
      "time-cost",
    ]);
    expect(result.packageContent.rules.map((item) => item.id)).toEqual([
      "time-cost-2",
    ]);
  });

  it("preserves an existing package and admits only one concurrent creator", async () => {
    const options = {
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "Synthetic world",
      idleTimeoutMs: 5_000,
    };
    await mkdir(path.join(tmp, "test-world"));
    await writeFile(
      path.join(tmp, "test-world/world.yaml"),
      "id: preserved\n",
      "utf8",
    );
    const generated = await createWorld(options);
    if (!generated.success) throw new Error(generated.errors.join("; "));
    await expect(writeWorldPackage(tmp, generated)).rejects.toThrow(
      "already exists",
    );
    expect(
      await readFile(path.join(tmp, "test-world/world.yaml"), "utf8"),
    ).toBe("id: preserved\n");
    await rm(path.join(tmp, "test-world"), { recursive: true });
    const results = await Promise.allSettled([
      writeWorldPackage(tmp, generated),
      writeWorldPackage(tmp, generated),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await readdir(tmp)).toEqual(["test-world"]);
    expect(await readFile(path.join(tmp, "test-world/WORLD.md"), "utf8")).toBe(
      WORLD_LORE,
    );
  });

  it("writes full lore when the model includes the end delimiter", async () => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_LORE}\n===END===`,
      ),
      concept: "测试世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    await writeWorldPackage(tmp, result);
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
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    const files = await writeWorldPackage(tmp, result);
    expect(files).toContain("test-world/WORLD.zh-Hant-TW.md");
    expect(files).toContain("test-world/WORLD.md");
    expect(files).not.toContain("test-world/WORLD.zh.md");
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
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    await writeWorldPackage(tmp, result);
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
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    await writeWorldPackage(tmp, result);
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
pluginPolicy:
  requested: []
  recommended: []
extraRoot: ignored
dimensions:
  factions:
    name: factions
    schema: {}
    initialValue:
      - id: clock-guild
        name: 钟表公会
        description: 维护城镇时间秩序。
        type: Guild
        influence: Important
  powerSystem:
    name: powerSystem
    schema: {}
    initialValue:
      name: 分针术
      type: mystic
      description: 通过时间刻度施法。
      rules:
        - 每次施法都会留下刻痕
  history:
    name: history
    schema: {}
    initialValue:
      - name: 第一次倒转
        description: 城镇钟楼首次倒转。
        significance: Critical
  tone:
    name: tone
    schema: {}
    initialValue:
      genres:
        - mystery
      contentRating: TEEN
  mechanics:
    name: mechanics
    schema: {}
    initialValue:
      combatStyle: story
      difficulty: ADAPTIVE
  startingConditions:
    name: startingConditions
    schema: {}
    initialValue:
      openingScenario: 雨夜里，钟楼提前敲响，玩家必须选择追踪钟声或保护证人。
      startingResources:
        铜分: "3"
`;

    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n\`\`\`yaml\n${malformed}\n\`\`\`\n===WORLD_MD===\n${WORLD_LORE}`,
      ),
      concept: "测试世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    await writeWorldPackage(tmp, result);
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
    expect(dimensions).toContain("type: Guild");
    expect(dimensions).toContain("influence: Important");
    expect(dimensions).toContain("contentRating: TEEN");
    expect(dimensions).toContain("combatStyle: story");
    expect(dimensions).toContain("difficulty: ADAPTIVE");
    expect(dimensions).toContain('铜分: "3"');
  });

  it("keeps a usable world when one dimension is invalid and content falls short", async () => {
    const flawedYaml = WORLD_YAML.replace(
      "dimensions:",
      `dimensions:
  discoveries:
    name: 已知地点
    schema:
      type: object
      properties:
        visited: { boolean: true }
    initialValue: {}`,
    );
    const shortPackage = WORLD_PACKAGE_YAML.replace(
      /\n {2}- \{ id: reverse-hour[^\n]*\n/,
      "\n",
    );
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${flawedYaml}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${shortPackage}\n===END===`,
      ),
      concept: "雨中的倒转钟城",
      idleTimeoutMs: 5_000,
      brief: { content: ["characters", "lorebook", "rules"] },
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.manifest.dimensions).not.toHaveProperty("discoveries");
    expect(result.manifest.dimensions).toHaveProperty("geography");
    expect(result.packageContent.lorebook).toHaveLength(3);
    expect(result.warnings).toEqual([
      expect.stringContaining('dropped dimension "discoveries"'),
      "generated 3 lorebook entries; the brief asks for 4",
    ]);
  });

  it("writes requested portable world-package supplements", async () => {
    const enrichedYaml = WORLD_YAML.replace(
      "  startingConditions:",
      `  coins:
    name: Coins
    schema: { type: integer, minimum: 0 }
    initialValue: 8
  matches:
    name: Matches
    schema: { type: integer, minimum: 0 }
    initialValue: 2
  startingConditions:`,
    );
    const memoryPackage =
      WORLD_PACKAGE_YAML +
      `
contractData:
  - contract: memory.blocks@1
    key: world
    value:
      id: world
      blocks:
        - label: time_debt
          displayName: 时间债
          extractionHint: 玩家改写时间付出的记忆与后果。
        - label: erased_clues
          displayName: 被删除的线索
          extractionHint: 只在雨中显现、随后可能再次消失的证据。
`;
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${enrichedYaml}\n===WORLD_MD===\n${WORLD_LORE}\n===WORLD_PACKAGE_YAML===\n${memoryPackage}\n===END===`,
      ),
      concept: "雨中的倒转钟城",
      idleTimeoutMs: 5_000,
      brief: {
        experienceMode: "dialogue-mode",
        content: ["characters", "lorebook", "rules", "opening-kit"],
        contracts: ["memory.blocks@1"],
        additionalInstructions: "让角色彼此隐瞒一段共同历史。",
      },
      dataContracts: [
        {
          contract: "memory.blocks@1",
          schema: { type: "object" },
          validate: (value) =>
            Array.isArray((value as { blocks?: unknown }).blocks),
          pluginId: "memory",
        },
      ],
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    if (!result.success) throw new Error(result.errors.join("; "));
    await writeWorldPackage(tmp, result);
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
    expect(manifest).toContain("presetId: dialogue-mode");
    expect(manifest).toContain("defaultViewMode: stage");
    expect(manifest).not.toContain("memoryBlocks:");
    expect(manifest).toMatch(/requested:[\s\S]*- memory/);
    expect(descriptor).toContain("to: contract:memory.blocks@1");
    expect(
      JSON.parse(
        await readFile(
          path.join(tmp, "test-world", "data/contract-0.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      id: "world",
      blocks: [{ label: "time_debt" }, { label: "erased_clues" }],
    });
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
      "The opening choices and all 3 adventure hooks must revolve around the same current crisis or pressure mechanism.",
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

/**
 * A player revises a generated world in one sentence. The model gets the
 * current package and returns the same sections; what it leaves alone comes
 * back as `UNCHANGED` and is kept as it is.
 */
describe("createWorld revision", () => {
  const current = {
    yaml: WORLD_YAML,
    lore: WORLD_LORE,
    packageYaml: WORLD_PACKAGE_YAML,
  };
  const sections = (yaml: string, lore: string, pack?: string) =>
    `===WORLD_YAML===\n${yaml}\n===WORLD_MD===\n${lore}\n${pack === undefined ? "" : `===WORLD_PACKAGE_YAML===\n${pack}\n`}===END===`;

  /** Records what the model was asked. */
  class RecordingLlm implements LLMAdapter {
    readonly requests: string[] = [];
    constructor(private readonly answers: string[]) {}
    async generate(request: {
      messages: readonly { role: string; content: unknown }[];
    }): Promise<LLMResponse> {
      this.requests.push(
        request.messages
          .filter((message) => message.role === "user")
          .map((message) => String(message.content))
          .join("\n---\n"),
      );
      return {
        content: this.answers[this.requests.length - 1] ?? this.answers.at(-1)!,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  }

  it("keeps each section the model marks UNCHANGED and takes the one it rewrote", async () => {
    const lore = `${WORLD_LORE}\n4. 一名自称对手的校时官开始抢先一步行动。`;
    const llm = new RecordingLlm([sections("UNCHANGED", lore, "UNCHANGED")]);
    const result = await createWorld({
      llm,
      concept: "测试世界",
      revision: { current, instruction: "加一个对手的冒险钩子" },
    });

    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.id).toBe("test-world");
    expect(result.lore).toContain("自称对手的校时官");
    expect(result.manifest.dimensions).toHaveProperty("factions");
    expect(result.packageContent.characters.map((item) => item.id)).toEqual([
      "bell-keeper",
      "rain-courier",
      "minute-thief",
    ]);
    // The model saw the request and the whole current package.
    expect(llm.requests[0]).toContain("加一个对手的冒险钩子");
    expect(llm.requests[0]).toContain("id: test-world");
    expect(llm.requests[0]).toContain("id: bell-keeper");
  });

  it("keeps the package when the model does not write that section", async () => {
    const result = await createWorld({
      llm: new RecordingLlm([sections(WORLD_YAML, WORLD_LORE)]),
      concept: "测试世界",
      revision: { current, instruction: "不改任何内容" },
    });
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.packageContent.characters).toHaveLength(3);
  });

  it("keeps the lists and fields that a rewritten section does not repeat", async () => {
    // "Add a character": the model writes the new character and nothing
    // else of the package, and one field of the manifest.
    const cast = `characters:
  - { schemaVersion: 1, id: rival-keeper, name: 对手校时官, role: npc }`;
    const result = await createWorld({
      llm: new RecordingLlm([sections("name: 倒转之城", "UNCHANGED", cast)]),
      concept: "测试世界",
      revision: { current, instruction: "加一个对手角色，并把世界改名" },
    });

    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.manifest.name).toBe("倒转之城");
    // The rest of the manifest, with its dimensions, is still there.
    expect(result.manifest.summary).toBe("一个用于生成器测试的世界。");
    expect(Object.keys(result.manifest.dimensions as object)).toHaveLength(9);
    // The cast keeps its three characters, as they were, and gains one.
    expect(result.packageContent.characters.map((item) => item.id)).toEqual([
      "bell-keeper",
      "rain-courier",
      "minute-thief",
      "rival-keeper",
    ]);
    expect(result.packageContent.characters[0]!.description).toBe(
      "唯一记得真实时间的人。",
    );
    // The lore entries were not lost.
    expect(result.packageContent.lorebook).toHaveLength(4);
    expect(result.packageContent.rules).toHaveLength(3);
  });

  it("changes one item of a list and removes another by its id", async () => {
    const pack = `characters:
  - { schemaVersion: 1, id: minute-thief, name: 窃分者, role: npc, description: 已经悔改，正在归还偷走的时间。 }
  - { id: rain-courier, remove: true }
rules:
  - { id: time-cost, remove: true }`;
    const result = await createWorld({
      llm: new RecordingLlm([sections("UNCHANGED", "UNCHANGED", pack)]),
      concept: "测试世界",
      revision: {
        current,
        instruction: "让窃分者悔改，去掉雨信使和时间代价规则",
      },
    });

    if (!result.success) throw new Error(result.errors.join("; "));
    const { characters, rules, lorebook } = result.packageContent;
    expect(characters.map((item) => item.id)).toEqual([
      "bell-keeper",
      "minute-thief",
    ]);
    expect(characters[1]!.description).toBe("已经悔改，正在归还偷走的时间。");
    expect(rules.map((item) => item.id)).toEqual([
      "rain-reveals",
      "clocks-disagree",
    ]);
    expect(lorebook).toHaveLength(4);
  });

  it("changes one dimension and keeps the others", async () => {
    const yaml = `dimensions:
  factions:
    name: factions
    schema: {}
    initialValue:
      - { id: clock-guild, name: 钟表公会, description: 维护城镇时间秩序。, type: guild, influence: major }
      - { id: reverse-hand, name: 逆针会, description: 想让全城的钟倒着走。, type: cult, influence: minor }
  history: null`;
    const result = await createWorld({
      llm: new RecordingLlm([sections(yaml, "UNCHANGED", "UNCHANGED")]),
      concept: "测试世界",
      revision: { current, instruction: "改成两个派系，去掉历史" },
    });

    if (!result.success) throw new Error(result.errors.join("; "));
    const dimensions = result.manifest.dimensions as Record<
      string,
      { initialValue: unknown[] }
    >;
    expect(dimensions.factions!.initialValue).toHaveLength(2);
    expect(dimensions).toHaveProperty("geography");
    expect(dimensions).not.toHaveProperty("history");
  });

  it("keeps the id of the world whatever the model writes", async () => {
    const result = await createWorld({
      llm: new RecordingLlm([
        sections(
          WORLD_YAML.replace("id: test-world", "id: renamed-world").replace(
            "name: 测试世界",
            "name: 倒转之城",
          ),
          "UNCHANGED",
          "UNCHANGED",
        ),
      ]),
      concept: "测试世界",
      revision: { current, instruction: "把世界改名为倒转之城" },
    });
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.id).toBe("test-world");
    expect(result.manifest.name).toBe("倒转之城");
  });

  it("asks again with the request when the revised package cannot be imported", async () => {
    const llm = new RecordingLlm([
      sections("id: [broken", "UNCHANGED", "UNCHANGED"),
      sections("UNCHANGED", "UNCHANGED", "UNCHANGED"),
    ]);
    const result = await createWorld({
      llm,
      concept: "测试世界",
      revision: { current, instruction: "加一个派系" },
    });
    expect(result.success).toBe(true);
    expect(llm.requests).toHaveLength(2);
    // The second request still carries what to revise, then the error.
    expect(llm.requests[1]).toContain("加一个派系");
    expect(llm.requests[1]).toContain("could not be imported");
  });
});

describe("writeWorldPackage replace", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "covel-replace-world-"));
  });
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });
  const generate = async (lore: string) => {
    const result = await createWorld({
      llm: new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${lore}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`,
      ),
      concept: "Clockwork city",
    });
    if (!result.success) throw new Error(result.errors.join("; "));
    return result;
  };

  it("writes a revised world over the package of the same id", async () => {
    await writeWorldPackage(tmp, await generate(WORLD_LORE));
    // A file the first package had and the revised one does not write.
    await writeFile(path.join(tmp, "test-world", "WORLD.en.md"), "old");

    const revised = await generate(`${WORLD_LORE}\n4. 新的钩子。`);
    await expect(writeWorldPackage(tmp, revised)).rejects.toThrow(
      "already exists",
    );
    await writeWorldPackage(tmp, revised, { replace: true });

    expect(
      await readFile(path.join(tmp, "test-world", "WORLD.md"), "utf8"),
    ).toContain("新的钩子");
    await expect(
      access(path.join(tmp, "test-world", "WORLD.en.md")),
    ).rejects.toThrow();
    // Nothing is left beside the package.
    expect(await readdir(tmp)).toEqual(["test-world"]);
  });

  it("does not create a package that was not there", async () => {
    await expect(
      writeWorldPackage(tmp, await generate(WORLD_LORE), { replace: true }),
    ).rejects.toThrow("does not exist");
    expect(await readdir(tmp)).toEqual([]);
  });
});
