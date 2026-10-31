import { readFileSync } from "node:fs";
import path from "node:path";
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
  let definition;
  let manifest;
  let english;
  let chinese;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(path.dirname(PLUGIN_DIR));
    const discovery = discoveries.find((item) => item.id === PLUGIN_ID);
    definition = await loadPluginDefinition(discovery);
    manifest = definition.manifests.find(
      ({ manifest }) => manifest.outputKind === "story",
    ).manifest;
    english = (await loadRuntime(discovery, manifest.name)).promptTemplate;
    // The variant holds only translated text: its body follows the frontmatter.
    chinese = readFileSync(
      path.join(PLUGIN_DIR, "runtimes/narrate/RUNTIME.zh.md"),
      "utf8",
    )
      .split(/^---$/m)
      .slice(2)
      .join("---");
  });

  it("is the story runtime of the narrative stage and provides the narrative engine", () => {
    expect(manifest).toMatchObject({
      name: `${PLUGIN_ID}/narrate`,
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
    expect(manifest.output?.recordAs).toBe("latest-story");
    const planner = definition.manifests.find(
      ({ manifest }) => manifest.name === `${PLUGIN_ID}/plan`,
    ).manifest;
    expect(planner.input.inject).toContainEqual({
      kind: "runtime-export",
      name: "previous",
      from: { runtime: manifest.name },
      recordAs: "latest-story",
      required: false,
    });
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
    for (const file of ["PLUGIN.md", "runtimes/narrate/RUNTIME.zh.md"])
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

  it("requires no other package and reads every contract input as optional", () => {
    expect(definition.packageManifest.plugin.requires ?? []).toEqual([]);
    const inputs = Object.values(manifest.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.required).toBe(false);
    expect(manifest.needs ?? []).toEqual([]);
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
    const en = source("runtimes/narrate/RUNTIME.md") + source("PLUGIN.md");
    const zh =
      source("runtimes/narrate/RUNTIME.zh.md") + source("PLUGIN.zh.md");
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
    for (const text of [en, zh]) {
      expect(text).not.toContain("stage.direction");
      expect(text).not.toContain("actor.focus");
    }
  });

  it("preserves the declared runtime inputs, tools and scheduling", () => {
    expect(definition.packageManifest.plugin.runtime).toBeUndefined();
    expect(
      definition.manifests.map(({ manifest }) => manifest.name).sort(),
    ).toEqual([`${PLUGIN_ID}/narrate`, `${PLUGIN_ID}/plan`]);
    expect(
      definition.manifests.filter(
        ({ manifest }) => manifest.outputKind === "story",
      ),
    ).toHaveLength(1);
    expect(manifest.inputs.plan).toMatchObject({ required: false });
    expect(Object.keys(manifest.inputs).sort()).toEqual(
      [
        "active-cast",
        "check-results",
        "npc-relationships",
        "plan",
        "storyEvent",
        "tabletopCheck",
        "worldTime",
      ].sort(),
    );
    expect(manifest.tools.builtin).toEqual([
      "list-characters",
      "get-character",
      "memory-search",
      "emit-event",
      "delegate",
    ]);
    expect(english).toContain('target: { contract: "character-actor@1" }');
    expect(chinese).toContain('target: { contract: "character-actor@1" }');
    expect(english).toContain("runtime-inputs.active-cast");
    expect(chinese).toContain("runtime-inputs.active-cast");
    expect(definition.packageManifest.plugin.imports ?? []).toEqual([]);
  });
});
