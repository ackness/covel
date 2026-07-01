import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
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
      runtimeType: "function",
      outputKind: "system",
      priority: 700,
      handler: "./handler.js",
      // auto so the seed path runs after the narrative engines each turn;
      // the manual createCandidates / acceptCandidate actions still arrive via
      // plugin-rpc manualTrigger regardless of the declared trigger type.
      trigger: { type: "auto" },
      capabilities: ["branch-reply", "prompt-history-rewriter"],
      ui: {
        message: ["./ui/branch-reply-block.json"],
      },
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
    expect(loaded.handler).toBeTypeOf("function");
    expect(loaded.uiSpecs?.message).toHaveLength(1);
    expect(loaded.uiSpecs?.message?.[0]).toMatchObject({
      id: "branch-reply",
      dataSource: { namespace: "message" },
      view: {
        component: "BranchReplyCandidates",
        props: {
          pluginId: "branch-reply",
        },
      },
    });
  });
});
