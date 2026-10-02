/**
 * Integration test: drive `createEventDirectory` off the *real* bundled
 * `plugins/scene-stage` manifest — discover → register → activate → directory,
 * the same chain `bootstrap.ts` wires. Pins what a synthetic-manifest unit
 * test can't: scene-stage's public event contracts really resolve and validate
 * against their on-disk schemas. A future layout regression (schema path or
 * decl location) fails here.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
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

  const definition = await loadPluginDefinition(discovery);
  const registry = createPluginRegistry();
  registry.register({
    id: discovery.id,
    summary: await loadPluginSummary(discovery, undefined, definition),
    rootPath: discovery.rootPath,
    ...definition,
    loadedRuntimes: new Map(),
    status: "registered",
  });
  registry.syncSessionActivations(SESSION_ID, [discovery.id]);

  const directory = createEventDirectory({
    registry,
    resolvePluginDir: (id) =>
      id === discovery.id ? discovery.rootPath : undefined,
  });
  return directory;
}

describe("event directory — real scene-stage manifest", () => {
  it("advertises the public stage topics", async () => {
    const directory = await setupSceneStageDirectory();
    const topics = await directory.listTopics(SESSION_ID);
    expect([...topics].sort()).toEqual(["scene.set", "stage.direction"]);
    const catalog = await directory.catalogText(SESSION_ID, "en-US");
    expect(catalog).toContain('"enum":["actor.enter","actor.update"]');
    expect(catalog).toContain('"required":["type","character"]');
    expect(catalog).toContain('"$defs"');
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

  it("validates stage.direction cues against the on-disk schema", async () => {
    const directory = await setupSceneStageDirectory();
    const result = await directory.validate(SESSION_ID, "stage.direction", {
      cues: [
        {
          type: "actor.enter",
          character: "朝仓凛",
          position: "left",
          outfit: "uniform",
          expression: "smile",
          focus: true,
        },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects an unknown stage.direction cue", async () => {
    const directory = await setupSceneStageDirectory();
    const result = await directory.validate(SESSION_ID, "stage.direction", {
      cues: [{ type: "actor.teleport", character: "朝仓凛" }],
    });
    expect(result.ok).toBe(false);
  });
});
