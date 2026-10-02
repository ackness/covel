import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadPluginUi,
  loadRuntime,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(import.meta.dirname, "..");
const pluginsDir = path.dirname(pluginDir);

async function discover() {
  const discoveries = await discoverPlugins(pluginsDir);
  const discovery = discoveries.find(
    (candidate) => candidate.id === "character-blueprint",
  );
  expect(discovery).toBeDefined();
  return discovery;
}

describe("character-blueprint manifest and UI loading", () => {
  it("loads the import and presence runtimes as manual functions", async () => {
    const discovery = await discover();
    const manifests = (await loadPluginManifest(discovery)).map(
      (entry) => entry.manifest,
    );

    expect(manifests.map((manifest) => manifest.name).sort()).toEqual([
      "character-blueprint/import",
      "character-blueprint/presence",
    ]);
    for (const manifest of manifests) {
      expect(manifest).toMatchObject({
        pluginId: "character-blueprint",
        runtimeType: "function",
        handler: "./handler.js",
        trigger: { type: "manual" },
      });
      const loaded = await loadRuntime(discovery, manifest.name);
      expect(loaded.handler).toBeTypeOf("function");
    }
    expect(
      Object.fromEntries(
        manifests.map((manifest) => [manifest.name, manifest.outputContract]),
      ),
    ).toEqual({
      "character-blueprint/import": "character-blueprint@1",
      "character-blueprint/presence": "character-presence@1",
    });
  });

  it("loads the preset and portrait panels", async () => {
    const ui = await loadPluginUi(await discover());
    const [blueprints, portraits] = ui.uiSpecs?.right ?? [];

    // Read-only display panel (no editing): relies on emptyState rather than
    // alwaysRender, so a world without preset characters shows the empty hint.
    expect(blueprints).toMatchObject({
      id: "character-blueprint",
      group: "character",
      dataSource: { namespace: "blueprints" },
    });
    expect(blueprints?.emptyState).toBeDefined();
    expect(portraits).toMatchObject({
      id: "character-presence",
      group: "character-art",
      dataSource: { namespace: "presence" },
      alwaysRender: true,
      view: {
        props: {
          replaceAction: {
            pluginId: "character-blueprint",
            runtimeId: "character-blueprint/presence",
          },
        },
      },
    });
  });
});
