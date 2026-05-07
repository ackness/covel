import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventBus } from "@covel/events";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { loadSessionConfig } from "../../src/routes/api/load-session-config.js";

type Env = {
  Variables: {
    store: DataStore;
    eventBus: ReturnType<typeof createEventBus>;
    pluginRegistry: PluginRegistry;
    worldsDirs?: readonly string[];
    covelHome?: string;
  };
};

function createTestApp(
  store: DataStore,
  pluginRegistry: PluginRegistry,
  options: { worldsDirs?: readonly string[]; covelHome?: string } = {},
): Hono<Env> {
  const eventBus = createEventBus();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", pluginRegistry);
    if (options.worldsDirs) c.set("worldsDirs", options.worldsDirs);
    if (options.covelHome) c.set("covelHome", options.covelHome);
    await next();
  });
  app.route("/api/worlds", worldRoutes);
  return app;
}

function makeDimensions(regionName: string, factionName: string) {
  return {
    geography: {
      regions: [
        {
          name: regionName,
          description: `${regionName} description`,
          climate: "temperate",
        },
      ],
    },
    factions: [
      {
        id: "guild",
        name: factionName,
        description: `${factionName} description`,
        type: "guild" as const,
        influence: "minor" as const,
      },
    ],
  };
}

async function makeWorldDataFixture() {
  const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-worlds-api-"));
  const worldRoot = path.join(worldsDir, "preflight-world");
  await mkdir(path.join(worldRoot, "data"), { recursive: true });
  await writeFile(
    path.join(worldRoot, "world.yaml"),
    `schemaVersion: "1"
id: preflight-world
name: Preflight World
summary: Preflight world
defaultLocale: zh-CN
worldData: data/world.data.yaml
`,
  );
  await writeFile(
    path.join(worldRoot, "data/world.data.yaml"),
    `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
  );
  await writeFile(
    path.join(worldRoot, "data/facts.json"),
    JSON.stringify([{ id: "one", content: "One fact." }]),
  );
  return { worldsDir };
}

describe("world routes", () => {
  let store: DataStore;
  let app: Hono<Env>;

  beforeEach(() => {
    store = createMemoryStore();
    const pluginRegistry = {
      findPluginByCapability: () => "world-data-provider",
      get: () => undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry);
  });

  it("PATCH /api/worlds/:id accepts top-level dimensions and preserves sibling metadata", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-1",
      name: "World 1",
      description: "desc",
      metadata: {
        dimensions: makeDimensions("Old Reach", "Old Guild"),
        publishing: { status: "draft" },
      },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds/world-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dimensions: makeDimensions("New Reach", "Guild"),
      }),
    });

    expect(res.status).toBe(200);
    const world = await store.getWorld("world-1");
    const metadata = world?.metadata as Record<string, unknown>;
    expect(metadata.publishing).toEqual({ status: "draft" });
    expect(metadata.dimensions).toEqual(makeDimensions("New Reach", "Guild"));
  });

  it("POST /api/worlds/:id/sync-dimensions refreshes plugin_data and lorebook entries together", async () => {
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "world-2",
      name: "World 2",
      description: "desc",
      metadata: {
        dimensions: makeDimensions("North", "Guild"),
      },
      createdAt: now,
      updatedAt: now,
    });
    await store.createSession({
      id: "sess-1",
      worldId: "world-2",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginDataBatch([
      {
        id: "pd-geography-old",
        sessionId: "sess-1",
        pluginId: "world-data-provider",
        namespace: "entries",
        key: "geography",
        value: {
          regions: [
            {
              name: "Old",
              description: "Old description",
              climate: "dry",
            },
          ],
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pd-obsolete",
        sessionId: "sess-1",
        pluginId: "world-data-provider",
        namespace: "entries",
        key: "obsolete",
        value: { keep: false },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await store.upsertLorebookEntries([
      {
        id: "world-entry:geography",
        sessionId: "sess-1",
        pluginId: "world-data-provider",
        keys: ["geography"],
        content: "[geography]\nold lore",
        strategy: "constant",
        position: "after_char_defs",
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "world-entry:obsolete",
        sessionId: "sess-1",
        pluginId: "world-data-provider",
        keys: ["obsolete"],
        content: "[obsolete]\nold lore",
        strategy: "constant",
        position: "after_char_defs",
        insertionOrder: 200,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await app.request("/api/worlds/world-2/sync-dimensions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-1" }),
    });

    expect(res.status).toBe(200);

    const pluginData = await store.listPluginData(
      "sess-1",
      "world-data-provider",
      "entries",
    );
    expect(pluginData.map((record) => record.key).sort()).toEqual([
      "factions",
      "geography",
    ]);
    expect(
      pluginData.find((record) => record.key === "geography")?.value,
    ).toEqual(makeDimensions("North", "Guild").geography);

    const lorebookEntries = (await store.listSessionLorebookEntries("sess-1"))
      .filter((entry) => entry.pluginId === "world-data-provider")
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(lorebookEntries.map((entry) => entry.id)).toEqual([
      "world-entry:factions",
      "world-entry:geography",
    ]);
    expect(lorebookEntries[0]?.content).toBe(
      '[factions]\n[\n  {\n    "id": "guild",\n    "name": "Guild",\n    "description": "Guild description",\n    "type": "guild",\n    "influence": "minor"\n  }\n]',
    );
    expect(lorebookEntries[1]?.content).toBe(
      '[geography]\n{\n  "regions": [\n    {\n      "name": "North",\n      "description": "North description",\n      "climate": "temperate"\n    }\n  ]\n}',
    );

    const cfg = await loadSessionConfig(
      store,
      "sess-1",
      "world-2",
      "world-data-provider",
    );
    expect(cfg.worldEntries).toEqual({
      factions:
        '[factions]\n[\n  {\n    "id": "guild",\n    "name": "Guild",\n    "description": "Guild description",\n    "type": "guild",\n    "influence": "minor"\n  }\n]',
      geography:
        '[geography]\n{\n  "regions": [\n    {\n      "name": "North",\n      "description": "North description",\n      "climate": "temperate"\n    }\n  ]\n}',
    });
  });

  it("POST /api/worlds/:id/world-data/preflight reports a read-only import plan", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const pluginRegistry = {
      findPluginByCapability: () => undefined,
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, { worldsDirs: [worldsDir] });

    const res = await app.request(
      "/api/worlds/preflight-world/world-data/preflight",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: ["world-notes"] }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imported: boolean;
      planned: number;
      diagnostics: Array<{ level: string; message: string }>;
      targets: Array<{ target: string; pluginId?: string; namespace?: string }>;
    };
    expect(body.imported).toBe(true);
    expect(body.planned).toBe(1);
    expect(body.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(body.targets).toMatchObject([
      {
        target: "plugin:world-notes/facts",
        pluginId: "world-notes",
        namespace: "facts",
      },
    ]);
    expect(
      await store.listPluginData("preflight", "world-notes", "facts"),
    ).toEqual([]);
  });

  it("POST /api/worlds/:id/sync-data dry-runs and applies importer-managed updates", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const now = new Date().toISOString();
    const pluginRegistry = {
      findPluginByCapability: () => undefined,
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, { worldsDirs: [worldsDir] });
    await store.createSession({
      id: "sync-session",
      worldId: "preflight-world",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: ["world-notes"],
      createdAt: now,
      updatedAt: now,
    });

    const dryRun = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-session" }),
    });

    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({
      dryRun: true,
      upserted: 1,
      deleted: 0,
      unchanged: 0,
      conflicts: [],
    });
    expect(
      await store.listPluginData("sync-session", "world-notes", "facts"),
    ).toEqual([]);

    const apply = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-session", dryRun: false }),
    });

    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({
      dryRun: false,
      upserted: 1,
      deleted: 0,
      conflicts: [],
    });
    expect(
      await store.getPluginData("sync-session", "world-notes", "facts", "one"),
    ).toMatchObject({ value: { id: "one", content: "One fact." } });
  });

  it("POST /api/worlds/:id/sync-data reports modified managed rows as conflicts", async () => {
    const { worldsDir } = await makeWorldDataFixture();
    const now = new Date().toISOString();
    const pluginRegistry = {
      findPluginByCapability: () => undefined,
      get: (pluginId: string) =>
        pluginId === "world-notes"
          ? {
              id: "world-notes",
              dataSchemas: {
                facts: {
                  namespace: "facts",
                  schemaVersion: 1,
                  acceptsWorldData: true,
                },
              },
            }
          : undefined,
    } as PluginRegistry;
    app = createTestApp(store, pluginRegistry, { worldsDirs: [worldsDir] });
    await store.createSession({
      id: "sync-conflict",
      worldId: "preflight-world",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: ["world-notes"],
      createdAt: now,
      updatedAt: now,
    });
    await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-conflict", dryRun: false }),
    });
    await store.setPluginData({
      id: "manual-edit",
      sessionId: "sync-conflict",
      pluginId: "world-notes",
      namespace: "facts",
      key: "one",
      value: { id: "one", content: "Player edited." },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request("/api/worlds/preflight-world/sync-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sync-conflict", dryRun: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dryRun: false,
      upserted: 0,
      deleted: 0,
      conflicts: [
        {
          target: "plugin:world-notes/facts",
          key: "one",
          sourceId: "facts",
          reason: "modified",
        },
      ],
    });
    expect(
      await store.getPluginData("sync-conflict", "world-notes", "facts", "one"),
    ).toMatchObject({ value: { id: "one", content: "Player edited." } });
  });
});
