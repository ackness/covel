import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginUi,
  loadPluginManifest,
  parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(import.meta.dirname, "..");
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("living-world-rules manifest and UI loading", () => {
  it("parses as a package of data, a projection and a panel, with no runtime", () => {
    const parsed = parsePluginMd(
      readFileSync(pluginMdPath, "utf-8"),
      pluginMdPath,
    );

    expect(parsed.manifest).toMatchObject({
      name: "living-world-rules",
      pluginId: "living-world-rules",
      ui: {
        right: ["./ui/living-world-rules-panel.json"],
      },
      worldProjections: {
        "rules-from-world-ir": {
          from: "contract:world-ir@1",
          handler: "./server/project-world-ir.js",
          outputs: {
            rules: { namespace: "rules", key: "id" },
          },
        },
      },
    });
    expect(parsed.inlineRuntime).toBeUndefined();
    expect(parsed.plugin.provides).toEqual(
      expect.arrayContaining(["living-world-rules@1", "world-info@1"]),
    );
  });

  it("loads the rules right panel through plugin-loader", async () => {
    const discoveries = await discoverPlugins(pluginsDir);
    const discovery = discoveries.find(
      (candidate) => candidate.id === "living-world-rules",
    );
    expect(discovery).toBeDefined();

    expect(await loadPluginManifest(discovery)).toHaveLength(0);

    const ui = await loadPluginUi(discovery);
    expect(ui.uiSpecs?.right).toHaveLength(1);
    // Read-only display panel (no editing): relies on emptyState rather than
    // alwaysRender, so a world without declared rules shows the empty hint.
    expect(ui.uiSpecs?.right?.[0]).toMatchObject({
      id: "living-world-rules",
      dataSource: { namespace: "rules" },
    });
    expect(ui.uiSpecs?.right?.[0]?.emptyState).toBeDefined();
  });
});
