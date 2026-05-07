import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
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
  };
};

function createTestApp(
  store: DataStore,
  pluginRegistry: PluginRegistry,
): Hono<Env> {
  const eventBus = createEventBus();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("pluginRegistry", pluginRegistry);
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

describe("world routes", () => {
  let store: DataStore;
  let app: Hono<Env>;

  beforeEach(() => {
    store = createMemoryStore();
    const pluginRegistry = {
      findPluginByCapability: () => "world-data-provider",
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
});
