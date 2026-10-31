import { readFileSync } from "node:fs";
import path from "node:path";
import { createNarrativeReview } from "@covel/plugin-handlers-utils";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");
const PLUGIN_ID = path.basename(PLUGIN_DIR);

/** The `{{ … }}` placeholders of a prompt body, each one time, sorted. */
function placeholders(body) {
  return [
    ...new Set(
      [...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]),
    ),
  ].sort();
}

describe(`${PLUGIN_ID} package`, () => {
  it.each(["en-US", "zh-CN"])(
    "keeps game-master narration without a bound player in %s",
    (locale) => {
      const review = createNarrativeReview(PLUGIN_ID);
      const ctx = {
        pluginId: PLUGIN_ID,
        runtimeId: PLUGIN_ID,
        sessionId: "scene",
        turnId: "turn",
        locale,
        getOwnSettings: () => ({ perspective: "dm" }),
      };
      const text =
        locale === "zh-CN"
          ? "你们面前是一道门。你可以决定是否靠近。"
          : "You all face a gate. You may decide whether to approach.";
      const prepared = review.prepare(ctx, { messages: [] });
      const instruction = prepared.replace.messages.at(-1).content;
      expect(instruction).not.toMatch(/Player character:|玩家角色：/);
      expect(instruction).toContain(
        locale === "zh-CN"
          ? "不要复述玩家输入、替玩家添加行动或内心想法"
          : "Do not restate the player's input or add player actions/thoughts",
      );
      expect(
        review.review(ctx, {
          messages: [],
          response: {
            content: JSON.stringify({
              segments: [{ kind: "narration", text }],
            }),
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        }),
      ).toEqual({ action: "continue" });
    },
  );
  let definition;
  let manifest;
  let english;
  let chinese;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(path.dirname(PLUGIN_DIR));
    const discovery = discoveries.find((item) => item.id === PLUGIN_ID);
    definition = await loadPluginDefinition(discovery);
    manifest = definition.manifests[0].manifest;
    english = (await loadRuntime(discovery, manifest.name)).promptTemplate;
    // The variant holds only translated text: its body follows the frontmatter.
    chinese = readFileSync(path.join(PLUGIN_DIR, "PLUGIN.zh.md"), "utf8")
      .split(/^---$/m)
      .slice(2)
      .join("---");
  });

  it("is the story runtime of the narrative stage and provides the narrative engine", () => {
    expect(manifest).toMatchObject({
      name: PLUGIN_ID,
      runtimeType: "agent",
      stage: "narrative",
      outputKind: "story",
    });
    expect(
      definition.packageManifest.plugin.provides.map((item) =>
        typeof item === "string" ? item : item.contract,
      ),
    ).toContain("narrative-engine@2");
    // Two engines in one session would both write the turn.
    expect(definition.packageManifest.plugin.conflicts).toContain(
      "narrative-engine@2",
    );
  });

  it("asks for story segments through its output schema", () => {
    expect(manifest.outputContract).toBe("narrative-engine@2");
    expect(manifest.output?.schema).toBe("contract:narrative-engine@2");
    const schema = JSON.parse(
      readFileSync(
        path.join(PLUGIN_DIR, "schemas/narrative-engine.schema.json"),
        "utf8",
      ),
    );
    expect(schema.required).toEqual(["segments"]);
  });

  it("offers the five perspectives, character second person by default", () => {
    const settings = definition.packageManifest.manifest.userSettings ?? [];
    const perspective = settings.find(({ key }) => key === "perspective");
    expect(perspective).toMatchObject({
      type: "select",
      default: "character-second",
    });
    expect(perspective.options.map(({ value }) => value)).toEqual([
      "character-first",
      "character-second",
      "character-third",
      "omniscient",
      "dm",
    ]);
    expect(placeholders(english)).toContain("userSettings.perspective");
    expect(placeholders(chinese)).toContain("userSettings.perspective");
    // The stage reads nameplates from segments, not from an ID map.
    for (const file of ["PLUGIN.md", "PLUGIN.zh.md"])
      expect(readFileSync(path.join(PLUGIN_DIR, file), "utf8")).not.toMatch(
        /paragraph[S]peakers|narrative[P]erson/,
      );
  });

  it("imports optional bag tools and explains payment and refusal in both languages", () => {
    expect(manifest.tools.services).toEqual([
      { contract: "inventory.bag@1", name: "check-bag" },
      { contract: "inventory.change@1", name: "change-inventory" },
    ]);
    expect(definition.packageManifest.plugin.requires ?? []).toEqual([]);
    expect(manifest.needs ?? []).toEqual([]);
    expect(
      Object.values(manifest.inputs ?? {}).every(
        (input) => input.required === false,
      ),
    ).toBe(true);
    expect(english).toContain("When the `change-inventory` tool is offered");
    expect(english).toContain("with the payment first");
    expect(english).toContain(
      "If it is refused, narrate that the exchange does not happen",
    );
    expect(english).toContain("Call `check-bag`");
    expect(chinese).toContain("提供了 `change-inventory` 工具");
    expect(chinese).toContain("付款排在前面");
    expect(chinese).toContain("若被拒绝，就叙述交易没有发生");
    expect(chinese).toContain("调用 `check-bag`");
  });

  it("hands every player setting to the prompt, in both languages", () => {
    const settings = definition.packageManifest.manifest.userSettings ?? [];
    expect(settings.length).toBeGreaterThan(0);
    for (const { key } of settings) {
      expect(placeholders(english)).toContain(`userSettings.${key}`);
      expect(placeholders(chinese)).toContain(`userSettings.${key}`);
    }
  });

  it("fills the same placeholders in the Chinese body as in the English one", () => {
    expect(placeholders(chinese)).toEqual(placeholders(english));
  });

  it("needs no companion plugin that the player may turn off", () => {
    const companions = [
      "branch-reply@1",
      "living-world-rules@1",
      "character-blueprint@1",
      "character-presence@1",
    ];
    for (const contract of definition.packageManifest.plugin.requires ?? [])
      expect(companions).not.toContain(contract);
  });

  it("guides correctable lookups, staged changes and changed scene cues in both languages", () => {
    const source = (file) => readFileSync(path.join(PLUGIN_DIR, file), "utf8");
    const en = source("PLUGIN.md");
    const zh = source("PLUGIN.zh.md");
    expect(en).toContain("not-found error that lists the closest names");
    expect(zh).toContain("「未找到」错误并列出最接近的名字");
    expect(en).not.toContain("candidate names");
    expect(zh).not.toContain("候选名字");
    expect(en).toContain("A tool result may carry a `staged` notice.");
    expect(zh).toContain("工具结果里的 `staged` 提示");
    expect(
      english.match(/Start a new segment whenever the speaker changes/g),
    ).toHaveLength(1);
    expect(zh.match(/说话者一变就另起一段/g)).toHaveLength(1);
    expect(en).toContain("Set `cues.scene` to the place");
    expect(en).toContain("Leave a cue out while it has not changed.");
    expect(zh).toContain("没有变化时省略该提示");
    expect(en).not.toContain("`cues.scene` and `cues.mood` are optional");
    expect(zh).not.toContain("`cues.scene` 和 `cues.mood` 可以不写");
    expect(en.replace(/\s+/g, " ")).toContain(
      "tool definition lists the topics and payload shapes",
    );
    expect(zh).toContain("工具定义列出了各 topic 和 payload 的格式");
  });

  it("preserves the declared runtime inputs, tools and scheduling", () => {
    expect(definition.packageManifest.plugin.runtime).toEqual({
      schedule: { stage: "narrative" },
      io: {
        inputs: {
          worldTime: {
            from: { contract: "world-time-context@1" },
            required: false,
          },
          storyEvent: {
            from: { contract: "story-event-cue@1" },
            select: "/cueContext",
            required: false,
          },
          tabletopCheck: {
            from: { contract: "tabletop-check@1" },
            select: "/checkContext",
            required: false,
          },
          "npc-relationships": {
            from: { contract: "graph-rag@1" },
            select: "/npcContext",
            required: false,
          },
          "check-results": {
            from: { contract: "action-check@1" },
            select: "/checkContext",
            required: false,
          },
        },
        output: {
          contract: "narrative-engine@2",
          schema: "contract:narrative-engine@2",
        },
        visibility: "story",
      },
      agent: {
        tools: {
          services: [
            { contract: "inventory.bag@1", as: "check-bag" },
            { contract: "inventory.change@1", as: "change-inventory" },
          ],
          builtin: [
            "list-characters",
            "get-character",
            "memory-search",
            "emit-event",
            "world-dimension-get",
            "world-dimension-list",
          ],
        },
        advertiseEvents: true,
      },
    });
    expect(definition.packageManifest.plugin.imports ?? []).toEqual([]);
  });
});
