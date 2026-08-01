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

describe("player-identity manifest and UI loading", () => {
  it("parses the manual runtime manifest through the strict schema", () => {
    const parsed = parsePluginMd(
      readFileSync(pluginMdPath, "utf-8"),
      pluginMdPath,
    );

    // No player-facing UI: the player's voice/persona belongs on the character
    // card (set at creation), not a mid-play editor panel. player-identity is a
    // UI-less persona-provider (its handler stays for programmatic use).
    expect(parsed.manifest).toMatchObject({
      name: "player-identity",
      pluginId: "player-identity",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "manual" },
    });
    expect(parsed.manifest.ui).toBeUndefined();
  });

  it("loads as a UI-less persona provider through plugin-loader", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find(
      (candidate) => candidate.id === "player-identity",
    );
    expect(discovery).toBeDefined();

    const manifests = await loadPluginManifest(discovery);
    expect(manifests).toHaveLength(1);

    const loaded = await loadRuntime(discovery, "player-identity");
    expect(loaded.handler).toBeTypeOf("function");
    expect(loaded.uiSpecs?.right ?? []).toHaveLength(0);
  });
});
