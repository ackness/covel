import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  compileInlineRuntime,
  loadPluginUi,
  loadPluginManifest,
  loadPluginDefinition,
  loadRuntime,
  parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("guide manifest and UI loading", () => {
  it("parses package contributions separately from its inline runtime", () => {
    const parsed = parsePluginMd(
      readFileSync(pluginMdPath, "utf-8"),
      pluginMdPath,
    );

    expect(parsed.manifest).toMatchObject({
      name: "guide",
      pluginId: "guide",
      pluginType: "plugin",
      entry: "./server/index.js",
      ui: { message: ["./ui/guide-block.json"] },
    });
    expect(parsed.manifest).not.toHaveProperty("stage");
    expect(compileInlineRuntime(parsed)?.manifest).toMatchObject({
      name: "guide",
      pluginId: "guide",
      pluginType: "plugin",
      stage: "post-turn",
      model: "plugin",
      outputKind: "system",
      requireToolUse: true,
      completeAfterTools: ["generate-guide"],
      maxRetries: 0,
      trigger: {
        type: "scheduled",
        interval: 1,
      },
      tools: {
        plugin: ["generate-guide"],
      },
      effects: { parallelSafe: true },
    });
  });

  it("parses PLUGIN.md and loads ui.message through plugin-loader", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find((candidate) => candidate.id === "guide");
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].manifest).toMatchObject({
      name: "guide",
      pluginType: "plugin",
      stage: "post-turn",
      model: "plugin",
      outputKind: "system",
      trigger: {
        type: "scheduled",
        interval: 1,
      },
      // Engine-agnostic: the required typed binding is both the DAG gate and
      // the prompt input, so third-party narrative providers work by capability.
      inputs: {
        narrative: {
          from: {
            capability: "narrative-engine@1",
            cardinality: "one",
          },
          select: "/narrativeOutput",
          accepts: "./schemas/narrative-output.schema.json",
          required: true,
        },
      },
    });

    const loaded = await loadRuntime(discovery!, "guide");
    // Engine-agnostic body reads the capability-bound runtime input instead of
    // hardcoding a particular narrative runtime id.
    expect(loaded.promptTemplate).toContain("`runtime-inputs.narrative.value`");
    // The limits the tool enforces are stated in the prompt, per language.
    expect(loaded.promptTemplate).toContain(
      "`recap`: 1-3 sentences, at most 60 words.",
    );
    expect(loaded.promptTemplate).toContain(
      "`recap` holds confirmed story facts",
    );
    expect(loaded.promptTemplate).toContain(
      "`decision`: one sentence, at most 25 words",
    );
    // Suggestions start where this turn's narrative ends, and no rule asks
    // for one prompt of each type.
    expect(loaded.promptTemplate).toContain(
      "You must not offer an action that the narrative already completed",
    );
    expect(loaded.promptTemplate).toContain(
      "You must not fill a fixed set of types",
    );
    // A Chinese session reads the PLUGIN.zh.md variant with the same limits.
    const chinese = await loadRuntime(discovery!, "guide", "zh-CN");
    expect(chinese.promptTemplate).toContain(
      "`runtime-inputs.narrative.value`",
    );
    expect(chinese.promptTemplate).toContain("`recap`：1-3 句、20-240 个字符");
    expect(chinese.promptTemplate).toContain("只写已经确认的故事事实");
    expect(chinese.promptTemplate).toContain(
      "`decision`：一句话，8-120 个字符",
    );
    expect(chinese.promptTemplate).toContain(
      "叙事里已经做完的动作、已经回答的问题，不能再作为短句给出",
    );
    const ui = await loadPluginUi(discovery!);
    expect(ui.uiSpecs?.message).toHaveLength(1);
    expect(ui.uiSpecs?.message?.[0]).toMatchObject({
      id: "guide",
      dataSource: { namespace: "message" },
      view: {
        component: "Stack",
      },
    });
  });

  it("keeps the localized agent workflow aligned with the canonical tool contract", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find((candidate) => candidate.id === "guide");
    const loaded = await loadRuntime(discovery!, "guide", "en-US");

    expect(loaded.promptTemplate).toContain("`runtime-inputs.narrative.value`");
    expect(loaded.promptTemplate).toContain("`recap`");
    expect(loaded.promptTemplate).toContain("`decision`");
    const localizedPostHistory = JSON.stringify(
      (await loadPluginDefinition(discovery!, "en-US")).packageManifest.plugin
        .contributes?.prompt,
    );
    expect(localizedPostHistory).toContain("Do not call `runtime-done`");
    expect(localizedPostHistory).not.toContain(
      "immediately call `runtime-done`",
    );
  });

  it("drafts suggestions into the composer without per-card send buttons", async () => {
    const ui = JSON.parse(
      readFileSync(path.join(pluginDir, "ui/guide-block.json"), "utf-8"),
    ) as unknown;

    const actions: string[] = [];
    const labels: unknown[] = [];
    function walk(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      const obj = value as Record<string, unknown>;
      const on = obj.on as Record<string, unknown> | undefined;
      const click = on?.click as Record<string, unknown> | undefined;
      if (typeof click?.action === "string") actions.push(click.action);
      const props = obj.props as Record<string, unknown> | undefined;
      if (props && Object.hasOwn(props, "label")) labels.push(props.label);
      for (const child of Object.values(obj)) walk(child);
    }
    walk(ui);

    expect(actions).toContain("draftMessage");
    expect(actions).not.toContain("sendMessage");
    expect(labels).not.toContainEqual({ zh: "发送", en: "Send" });
    expect(JSON.stringify(ui)).toContain('"$state":"/recap"');
    expect(JSON.stringify(ui)).toContain('"$state":"/decision"');
  });
});
