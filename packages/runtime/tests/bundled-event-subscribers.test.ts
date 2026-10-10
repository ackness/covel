/**
 * Event fan-out visits the subscribers of one topic in name order. That order
 * is outcome-neutral only while the subscribers of a topic belong to different
 * plugins, so this guard pins that property of the bundled plugin set.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

async function loadAllManifests(): Promise<readonly RuntimeManifest[]> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const manifests: RuntimeManifest[] = [];
  for (const discovery of discoveries) {
    const plugins = await loadPluginManifest(discovery);
    manifests.push(...plugins.map((plugin) => plugin.manifest));
  }
  return manifests;
}

describe("bundled event subscribers", () => {
  it("subscribers of one topic belong to different plugins, so name-order fan-out is outcome-neutral", async () => {
    // The fan-out sort switched to name order. It is observable only when a
    // single fan-out batch holds two subscribers of a pending topic whose
    // results depend on each other. Subscribers in one plugin could: they
    // share that plugin's data. Subscribers in different plugins cannot —
    // plugin data is owned per plugin, so each writes only its own (the
    // scene tracker and the soundtrack both follow `scene.set`). The bundled
    // set never puts two subscribers of one topic in one plugin, which keeps
    // the name sort identical in outcome to the old priority sort.
    const manifests = await loadAllManifests();
    const subscribers = new Map<string, string[]>();
    for (const manifest of manifests) {
      const topic =
        manifest.trigger?.type === "event" ? manifest.trigger.topic : undefined;
      if (typeof topic !== "string") continue;
      subscribers.set(topic, [
        ...(subscribers.get(topic) ?? []),
        manifest.pluginId,
      ]);
    }
    expect(subscribers.size).toBeGreaterThan(0);
    for (const [topic, plugins] of subscribers)
      expect(new Set(plugins).size, topic).toBe(plugins.length);
  });
});
