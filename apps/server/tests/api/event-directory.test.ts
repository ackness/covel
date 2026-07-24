import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  type ParsedPluginMd,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createEventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makePluginRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "covel-event-directory-"));
  tempRoots.push(root);
  return root;
}

async function writeSchema(
  root: string,
  fileName: string,
  schema: unknown,
): Promise<void> {
  await writeFile(path.join(root, fileName), JSON.stringify(schema));
}

function parsedManifest(
  patch: Partial<RuntimeManifest> & Pick<RuntimeManifest, "name" | "pluginId">,
): ParsedPluginMd {
  return {
    manifest: {
      description: "test runtime",
      ...patch,
    } as RuntimeManifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };
}

function registerPlugin(
  registry: ReturnType<typeof createPluginRegistry>,
  pluginId: string,
  manifest: ParsedPluginMd,
  rootPath: string,
): void {
  registry.register({
    id: pluginId,
    summary: {
      id: pluginId,
      name: pluginId,
      description: "",
      pluginType: "plugin",
      runtimeCount: 1,
    },
    rootPath,
    manifest,
    manifests: [manifest],
    loadedRuntimes: new Map(),
    status: "registered",
  });
}

const SCENE_SCHEMA = {
  type: "object",
  required: ["location"],
  properties: { location: { type: "string" } },
};

async function setupBasicSession() {
  const registry = createPluginRegistry();
  const rootPaths = new Map<string, string>();

  const rootA = await makePluginRoot();
  await writeSchema(rootA, "scene-set.event.json", SCENE_SCHEMA);
  rootPaths.set("plugin-a", rootA);
  registerPlugin(
    registry,
    "plugin-a",
    parsedManifest({
      name: "plugin-a/main",
      pluginId: "plugin-a",
      priority: 100,
      events: [
        {
          topic: "scene.set",
          schema: "scene-set.event.json",
          description: { "zh-CN": "场景切换", "en-US": "Scene change" },
          advertise: true,
        },
      ],
    }),
    rootA,
  );

  const rootB = await makePluginRoot();
  await writeSchema(rootB, "quest-done.event.json", {
    type: "object",
    required: ["questId"],
    properties: { questId: { type: "string" } },
  });
  rootPaths.set("plugin-b", rootB);
  registerPlugin(
    registry,
    "plugin-b",
    parsedManifest({
      name: "plugin-b/main",
      pluginId: "plugin-b",
      priority: 200,
      events: [
        {
          topic: "quest.done",
          schema: "quest-done.event.json",
          description: { "zh-CN": "任务完成" },
          advertise: false, // internal — emittable, not advertised
        },
      ],
    }),
    rootB,
  );

  const rootC = await makePluginRoot();
  await writeSchema(rootC, "npc-spawn.event.json", { type: "object" });
  rootPaths.set("plugin-c", rootC);
  registerPlugin(
    registry,
    "plugin-c",
    parsedManifest({
      name: "plugin-c/main",
      pluginId: "plugin-c",
      priority: 300,
      events: [
        {
          topic: "npc.spawn",
          schema: "npc-spawn.event.json",
          description: "NPC spawn",
          advertise: true,
        },
      ],
    }),
    rootC,
  );

  registry.activate("plugin-a", "sess-1");
  registry.activate("plugin-b", "sess-1");
  // plugin-c never activated in sess-1 — must be excluded from its directory.

  const directory = createEventDirectory({
    registry,
    resolvePluginDir: (pluginId) => rootPaths.get(pluginId),
  });

  return { registry, directory, rootPaths };
}

describe("event directory", () => {
  it("lists active plugins' advertised topics, excluding inactive plugins and advertise:false", async () => {
    const { directory } = await setupBasicSession();
    const topics = await directory.listTopics("sess-1");
    expect([...topics].sort()).toEqual(["scene.set"]);
  });

  it("omits advertise:false topics from both listTopics and catalogText", async () => {
    const { directory } = await setupBasicSession();
    const topics = await directory.listTopics("sess-1");
    expect(topics).not.toContain("quest.done");

    const catalog = await directory.catalogText("sess-1", "zh-CN");
    expect(catalog).toContain("scene.set");
    expect(catalog).not.toContain("quest.done");
  });

  it("rejects an advertise:false topic as unknown without leaking its name", async () => {
    const { directory } = await setupBasicSession();
    const result = await directory.validate("sess-1", "quest.done", {});
    expect(result).toEqual({
      ok: false,
      reason: 'unknown topic "quest.done"',
    });
  });

  it("renders topic, localized description, and required fields in catalogText", async () => {
    const { directory } = await setupBasicSession();
    const catalog = await directory.catalogText("sess-1", "zh-CN");
    expect(catalog).toContain("scene.set");
    expect(catalog).toContain("场景切换");
    expect(catalog).toContain("location");
  });

  it("renders enum-valued required fields as quoted allowed values in catalogText", async () => {
    const registry = createPluginRegistry();
    const root = await makePluginRoot();
    await writeSchema(root, "scene-set.event.json", {
      type: "object",
      required: ["location", "timeOfDay"],
      properties: {
        location: { type: "string" },
        timeOfDay: { enum: ["day", "night"] },
      },
    });
    registerPlugin(
      registry,
      "plugin-enum",
      parsedManifest({
        name: "plugin-enum/main",
        pluginId: "plugin-enum",
        events: [
          {
            topic: "scene.set",
            schema: "scene-set.event.json",
            description: "scene change",
            advertise: true,
          },
        ],
      }),
      root,
    );
    registry.activate("plugin-enum", "sess-enum");

    const directory = createEventDirectory({
      registry,
      resolvePluginDir: () => root,
    });

    const catalog = await directory.catalogText("sess-enum", "zh-CN");
    // enum values rendered (quoted) so the LLM's first emit picks a legal value
    expect(catalog).toContain('timeOfDay: "day"|"night"');
    // non-enum field keeps its type rendering
    expect(catalog).toContain("location: string");
  });

  it("returns an empty string for a session with no declared events", async () => {
    const { directory } = await setupBasicSession();
    expect(await directory.catalogText("sess-empty", "zh-CN")).toBe("");
  });

  it("validates a conforming payload as ok", async () => {
    const { directory } = await setupBasicSession();
    const result = await directory.validate("sess-1", "scene.set", {
      location: "教室",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a payload missing a required field with a reason naming the field", async () => {
    const { directory } = await setupBasicSession();
    const result = await directory.validate("sess-1", "scene.set", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("location");
  });

  it("rejects an unknown topic", async () => {
    const { directory } = await setupBasicSession();
    const result = await directory.validate("sess-1", "npc.spawn", {});
    expect(result).toEqual({
      ok: false,
      reason: 'unknown topic "npc.spawn"',
    });
  });

  it("returns a non-throwing 'schema unreadable' verdict when the schema file is missing", async () => {
    const registry = createPluginRegistry();
    const root = await makePluginRoot();
    // no schema file written for "missing.event.json"
    registerPlugin(
      registry,
      "plugin-x",
      parsedManifest({
        name: "plugin-x/main",
        pluginId: "plugin-x",
        events: [
          {
            topic: "x.missing",
            schema: "missing.event.json",
            description: "missing schema",
            advertise: true,
          },
        ],
      }),
      root,
    );
    registry.activate("plugin-x", "sess-x");

    const directory = createEventDirectory({
      registry,
      resolvePluginDir: () => root,
    });

    const result = await directory.validate("sess-x", "x.missing", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("schema unreadable");
  });

  it("warns once and keeps the lower-priority plugin's schema on cross-plugin topic conflicts", async () => {
    const registry = createPluginRegistry();
    const rootPaths = new Map<string, string>();

    const rootA = await makePluginRoot();
    await writeSchema(rootA, "scene-set.event.json", SCENE_SCHEMA);
    rootPaths.set("plugin-a", rootA);
    registerPlugin(
      registry,
      "plugin-a",
      parsedManifest({
        name: "plugin-a/main",
        pluginId: "plugin-a",
        priority: 100,
        events: [
          {
            topic: "scene.set",
            schema: "scene-set.event.json",
            description: "scene change (a)",
            advertise: true,
          },
        ],
      }),
      rootA,
    );

    const rootE = await makePluginRoot();
    await writeSchema(rootE, "scene-set-e.event.json", {
      type: "object",
      required: ["sceneId"],
      properties: { sceneId: { type: "string" } },
    });
    rootPaths.set("plugin-e", rootE);
    registerPlugin(
      registry,
      "plugin-e",
      parsedManifest({
        name: "plugin-e/main",
        pluginId: "plugin-e",
        priority: 200,
        events: [
          {
            topic: "scene.set",
            schema: "scene-set-e.event.json",
            description: "scene change (e)",
            advertise: true,
          },
        ],
      }),
      rootE,
    );

    registry.activate("plugin-a", "sess-2");
    registry.activate("plugin-e", "sess-2");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const directory = createEventDirectory({
      registry,
      resolvePluginDir: (pluginId) => rootPaths.get(pluginId),
    });

    // plugin-a wins first-wins: getActiveRuntimes now sorts by (stage, name), and
    // both runtimes are pre-turn (auto trigger), so "plugin-a/main" < "plugin-e/main"
    // by name → plugin-a first. Its schema requires "location", not "sceneId".
    const winnerResult = await directory.validate("sess-2", "scene.set", {
      location: "教室",
    });
    expect(winnerResult).toEqual({ ok: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("scene.set");
    expect(warn.mock.calls[0]?.[0]).toContain("plugin-a");
    expect(warn.mock.calls[0]?.[0]).toContain("plugin-e");
  });

  it("warns only once for a repeatedly re-encountered conflict on the same session+topic", async () => {
    const registry = createPluginRegistry();
    const rootPaths = new Map<string, string>();

    const rootA = await makePluginRoot();
    await writeSchema(rootA, "scene-set.event.json", SCENE_SCHEMA);
    rootPaths.set("plugin-a", rootA);
    registerPlugin(
      registry,
      "plugin-a",
      parsedManifest({
        name: "plugin-a/main",
        pluginId: "plugin-a",
        priority: 100,
        events: [
          {
            topic: "scene.set",
            schema: "scene-set.event.json",
            description: "scene change (a)",
            advertise: true,
          },
        ],
      }),
      rootA,
    );

    const rootE = await makePluginRoot();
    await writeSchema(rootE, "scene-set-e.event.json", {
      type: "object",
      required: ["sceneId"],
      properties: { sceneId: { type: "string" } },
    });
    rootPaths.set("plugin-e", rootE);
    registerPlugin(
      registry,
      "plugin-e",
      parsedManifest({
        name: "plugin-e/main",
        pluginId: "plugin-e",
        priority: 200,
        events: [
          {
            topic: "scene.set",
            schema: "scene-set-e.event.json",
            description: "scene change (e)",
            advertise: true,
          },
        ],
      }),
      rootE,
    );

    registry.activate("plugin-a", "sess-2");
    registry.activate("plugin-e", "sess-2");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const directory = createEventDirectory({
      registry,
      resolvePluginDir: (pluginId) => rootPaths.get(pluginId),
    });

    // Every call re-aggregates (session activation can change turn to turn),
    // so the same conflict is re-detected each time — the warn must still
    // fire only once for this (session, topic) pair.
    await directory.listTopics("sess-2");
    await directory.validate("sess-2", "scene.set", { location: "教室" });
    await directory.catalogText("sess-2", "en-US");

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
