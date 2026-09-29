import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  compileInlineRuntime,
  loadPluginUi,
  loadPluginManifest,
  loadRuntime,
  parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(import.meta.dirname, "..");
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("branch-reply manifest and UI loading", () => {
  it("parses the auto-seed runtime manifest through the strict schema", () => {
    const parsed = parsePluginMd(
      readFileSync(pluginMdPath, "utf-8"),
      pluginMdPath,
    );

    expect(parsed.manifest).toMatchObject({
      name: "branch-reply",
      pluginId: "branch-reply",
      pluginType: "plugin",
      extensions: [
        { point: "prompt.history-transform@1", id: "accepted-branch" },
      ],
      ui: {
        message: ["./ui/branch-reply-block.json"],
      },
    });
    expect(compileInlineRuntime(parsed).manifest).toMatchObject({
      name: "branch-reply",
      pluginId: "branch-reply",
      pluginType: "plugin",
      runtimeType: "function",
      outputKind: "system",
      stage: "post-turn",
      handler: "./handler.js",
      // Auto-seed runs after narrative; manual actions still use plugin RPC.
      trigger: { type: "auto" },
      outputContract: "branch-reply@1",
      effects: { parallelSafe: true },
    });
  });

  it("loads the branch reply message block through plugin-loader", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find(
      (candidate) => candidate.id === "branch-reply",
    );
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery);
    expect(manifests).toHaveLength(1);

    const loaded = await loadRuntime(discovery, "branch-reply");
    const ui = await loadPluginUi(discovery);
    expect(loaded.handler).toBeTypeOf("function");
    expect(ui.uiSpecs?.message).toHaveLength(1);
    expect(ui.uiSpecs?.message?.[0]).toMatchObject({
      id: "branch-reply",
      dataSource: { namespace: "message" },
      view: {
        component: "CandidateList",
        props: {
          acceptAction: { pluginId: "branch-reply" },
        },
      },
    });
  });
});
