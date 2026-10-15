import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadPluginDefinition,
  loadPluginUiSpecs,
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
  it("loads the presence runtime as its one manual function", async () => {
    const discovery = await discover();
    const manifests = (await loadPluginManifest(discovery)).map(
      (entry) => entry.manifest,
    );

    // Cards come from the world package; nothing writes them during play.
    expect(manifests.map((manifest) => manifest.name)).toEqual([
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
      "character-blueprint/presence": "character-presence@1",
    });
  });

  it("loads the portrait panel; the notes have no panel of their own", async () => {
    const discovery = await discover();
    const ui = await loadPluginUiSpecs(
      discovery.rootPath,
      discovery.id,
      (await loadPluginDefinition(discovery)).packageManifest.manifest.ui,
    );
    expect(ui.diagnostics).toEqual([]);
    // The characters the notes belong to are listed by the character list;
    // the notes themselves are for the narrator.
    expect(ui.slots.right).toHaveLength(1);
    const [portraits] = ui.slots.right ?? [];
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
