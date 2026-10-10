import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadPluginUi,
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
  it("has no runtime: the cast and portraits come from the world package", async () => {
    const discovery = await discover();
    // Cards and portraits come from the world package; nothing writes them during play.
    expect(await loadPluginManifest(discovery)).toEqual([]);
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
    });
    // Read-only: the gallery declares no action that writes a portrait.
    expect(JSON.stringify(portraits?.view)).not.toContain("Action");
  });
});
