/**
 * Integration test: drive `createEventDirectory` off the *real* bundled
 * `plugins/scene-stage` manifest — discover → register → activate → directory,
 * the same chain `bootstrap.ts` wires. Pins two things a synthetic-manifest
 * unit test can't: (1) scene-stage's `scene.set` contract really resolves and
 * validates against its on-disk schema, and (2) the `advertise: false`
 * internal topic (`scene-stage.generate.requested`) stays out of the catalogue
 * even after the events decl migrated onto the resolver runtime. A future
 * layout regression (schema path or decl location) fails here.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginManifest,
  loadPluginSummary,
} from "@covel/plugin-loader";
import { createEventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");
const SESSION_ID = "sess-real-manifest";

async function setupSceneStageDirectory() {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const discovery = discoveries.find((d) => d.id === "scene-stage");
  if (!discovery)
    throw new Error("scene-stage plugin not found under plugins/");

  const registry = createPluginRegistry();
  registry.register({
    id: discovery.id,
    summary: await loadPluginSummary(discovery),
    rootPath: discovery.rootPath,
    manifests: await loadPluginManifest(discovery),
    loadedRuntimes: new Map(),
    status: "registered",
  });
  registry.activate(discovery.id, SESSION_ID);

  const directory = createEventDirectory({
    registry,
    resolvePluginDir: (id) =>
      id === discovery.id ? discovery.rootPath : undefined,
  });
  return directory;
}

describe("event directory — real scene-stage manifest", () => {
  it("advertises scene.set and hides the advertise:false internal topic", async () => {
    const directory = await setupSceneStageDirectory();
    const topics = await directory.listTopics(SESSION_ID);
    expect(topics).toContain("scene.set");
    expect(topics).not.toContain("scene-stage.generate.requested");
  });

  it("validates a conforming scene.set payload against the on-disk schema", async () => {
    const directory = await setupSceneStageDirectory();
    const result = await directory.validate(SESSION_ID, "scene.set", {
      location: "教室",
      timeOfDay: "day",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a scene.set payload with an out-of-enum timeOfDay", async () => {
    const directory = await setupSceneStageDirectory();
    const result = await directory.validate(SESSION_ID, "scene.set", {
      location: "教室",
      timeOfDay: "dusk",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("timeOfDay");
  });
});
