import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
  parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("scene-prompts manifest and UI loading", () => {
  it("parses PLUGIN.md through the strict runtime manifest schema", () => {
    const parsed = parsePluginMd(
      readFileSync(pluginMdPath, "utf-8"),
      pluginMdPath,
    );

    expect(parsed.manifest).toMatchObject({
      name: "scene-prompts",
      pluginId: "scene-prompts",
      pluginType: "plugin",
      stage: "post-turn",
      model: "plugin",
      outputKind: "system",
      requireToolUse: true,
      completeAfterTools: ["generate-scene-prompts"],
      maxSteps: 2,
      maxRetries: 0,
      trigger: {
        type: "scheduled",
        interval: 1,
      },
      entry: "./server/index.js",
      tools: {
        plugin: ["generate-scene-prompts"],
      },
      effects: { parallelSafe: true },
      ui: {
        message: ["./ui/scene-prompts-block.json"],
      },
    });
  });

  it("parses PLUGIN.md and loads ui.message through plugin-loader", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find(
      (candidate) => candidate.id === "scene-prompts",
    );
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].manifest).toMatchObject({
      name: "scene-prompts",
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
            capability: "narrative-engine",
            cardinality: "one",
          },
          select: "/narrativeOutput",
          accepts: "./schemas/narrative-output.schema.json",
          required: true,
        },
      },
      ui: {
        message: ["./ui/scene-prompts-block.json"],
      },
    });

    const loaded = await loadRuntime(discovery!, "scene-prompts");
    // Engine-agnostic body reads the capability-bound runtime input instead of
    // hardcoding a particular narrative runtime id.
    expect(loaded.promptTemplate).toContain("<runtime-inputs>");
    expect(loaded.promptTemplate).toContain("`narrative.value`");
    expect(loaded.promptTemplate).toContain("`recap` 用 1-3 句、20-240 个字符");
    expect(loaded.promptTemplate).toContain("只写叙事或对话中已经确认的事实");
    expect(loaded.promptTemplate).toContain(
      "`decision` 用 8-120 个字符写出玩家当前需要回应的一个问题或决策点",
    );
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0]).toMatchObject({
      id: "scene-prompts",
      dataSource: { namespace: "message" },
      view: {
        component: "Stack",
      },
    });
  });

  it("keeps the localized agent workflow aligned with the canonical tool contract", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find(
      (candidate) => candidate.id === "scene-prompts",
    );
    const loaded = await loadRuntime(discovery!, "scene-prompts", "en-US");

    expect(loaded.promptTemplate).toContain("<runtime-inputs>");
    expect(loaded.promptTemplate).toContain("`recap`");
    expect(loaded.promptTemplate).toContain("`decision`");
    const localizedPostHistory = JSON.stringify(loaded.manifest.postHistory);
    expect(localizedPostHistory).toContain("Do not call `runtime-done`");
    expect(localizedPostHistory).not.toContain(
      "immediately call `runtime-done`",
    );
  });

  it("keeps scene prompt choices guide-like without per-card send buttons", async () => {
    const ui = JSON.parse(
      readFileSync(
        path.join(pluginDir, "ui/scene-prompts-block.json"),
        "utf-8",
      ),
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
