/**
 * Integration test: drive `createEventDirectory` off the *real* bundled
 * `plugins/scene-stage` manifest — discover → register → activate → directory,
 * the same chain `bootstrap.ts` wires. Pins what a synthetic-manifest unit
 * test can't: scene-stage's public event contracts really resolve and validate
 * against their on-disk schemas. A future layout regression (schema path or
 * decl location) fails here.
 */

import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
  loadPluginSummary,
  loadRuntime,
} from "@covel/plugin-loader";
import { buildSessionEmitEventTool } from "@covel/tools";
import { createEventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");
const SESSION_ID = "sess-real-manifest";

it("resolves root events and runtime-private output schemas at their different declaration directories", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-event-paths-"));
  const root = path.join(parent, "probe");
  const runtime = path.join(root, "runtimes/work");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(
      path.join(root, "PLUGIN.md"),
      "---\nid: probe\nkind: plugin\ndescription: Path fixture\ncontributes:\n  events:\n    - topic: probe.changed\n      schema: ./schema.json\n      description: A root event.\n---\n",
    );
    await writeFile(
      path.join(runtime, "RUNTIME.md"),
      "---\nschedule: {trigger: {type: manual}}\nio: {output: {schema: ./schema.json}}\n---\nReturn the private output.\n",
    );
    const schema = (kind: string) => ({
      type: "object",
      properties: { kind: { const: kind } },
      required: ["kind"],
      additionalProperties: false,
    });
    await writeFile(
      path.join(root, "schema.json"),
      JSON.stringify(schema("root")),
    );
    await writeFile(
      path.join(runtime, "schema.json"),
      JSON.stringify(schema("runtime")),
    );
    const discovery = (await discoverPlugins(parent))[0]!;
    const definition = await loadPluginDefinition(discovery);
    const registry = createPluginRegistry();
    registry.register({
      id: discovery.id,
      summary: await loadPluginSummary(discovery, undefined, definition),
      rootPath: root,
      ...definition,
      loadedRuntimes: new Map(),
      status: "registered",
    });
    registry.syncSessionActivations(SESSION_ID, [discovery.id]);
    const directory = createEventDirectory({
      registry,
      resolvePluginDir: () => root,
    });
    expect(
      await directory.validate(SESSION_ID, "probe.changed", { kind: "root" }),
    ).toEqual({ ok: true });
    expect(
      (
        await directory.validate(SESSION_ID, "probe.changed", {
          kind: "runtime",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await loadRuntime(discovery, "probe/work", "en-US", definition))
        .outputSchema,
    ).toEqual(schema("runtime"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

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
    // The emit-event tool describes both payloads in full, so the catalogue
    // lists the topics without repeating their schemas.
    const catalog = await directory.catalogText(SESSION_ID, "en-US");
    expect(catalog).toContain("- stage.direction:");
    expect(catalog).not.toContain("payload schema:");
    expect(catalog).not.toContain('"timeOfDay"');
    const described = await directory.describeTopics!(SESSION_ID);
    const tool = buildSessionEmitEventTool(
      { directory },
      described.map(({ topic, schema }) => ({ topic, schema })),
    )!;
    const properties = (
      tool.jsonSchema as {
        properties: {
          topic: { enum: string[] };
          data: { anyOf: Record<string, unknown>[] };
        };
      }
    ).properties;
    expect(properties.topic.enum.sort()).toEqual([
      "scene.set",
      "stage.direction",
    ]);
    const direction = JSON.stringify(
      properties.data.anyOf.find(
        (payload) => payload.title === "stage.direction",
      ),
    );
    expect(direction).toContain('"enum":["actor.enter","actor.update"]');
    expect(direction).toContain('"required":["type","character"]');
    expect(direction).not.toContain("$ref");
    expect(direction).not.toContain("$defs");
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
