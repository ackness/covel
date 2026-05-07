/**
 * GET /api/sessions/:id/state "database view" aggregation —
 * locks the right-panel Database tab contract. Before this change the
 * endpoint only returned `stateManager`-registered tables (currently zero)
 * so the Database tab was always empty even for sessions full of data.
 *
 * The endpoint now additionally surfaces:
 *   - `session` — the SessionRecord itself
 *   - `characters` — every character created in the session (when any)
 *   - `plugin_data/<pluginId>:<namespace>` — one virtual table per
 *     plugin_data namespace, keyed by the record's `key`
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createStateManager, type StateManager } from "@covel/state";
import { createMemoryStore, type DataStore } from "@covel/store";
import { stateRoutes } from "../../src/routes/api/state.js";

function buildApp(store: DataStore, stateManager: StateManager): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("stateManager", stateManager);
    await next();
  });
  app.route("/api/sessions", stateRoutes);
  return app;
}

describe("GET /api/sessions/:id/state — database view", () => {
  let store: DataStore;
  let app: Hono;
  const sessionId = "sess-db";

  beforeEach(async () => {
    store = createMemoryStore();
    app = buildApp(store, createStateManager(store));
    await store.createSession({
      id: sessionId,
      worldId: "cloudmere",
      presetId: "default",
      turnCount: 2,
      status: "active",
      locale: "zh-CN",
      activePlugins: ["narrator", "codex"],
      preGameCompleted: ["pregame"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("includes the session record as a virtual table", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tables: Record<
        string,
        {
          data: Record<string, unknown>;
          schema: { fields: { name: string }[] };
        }
      >;
    };

    const sess = body.tables.session;
    expect(sess).toBeDefined();
    expect(sess.data.id).toBe(sessionId);
    expect(sess.data.worldId).toBe("cloudmere");
    expect(sess.data.turnCount).toBe(2);
    expect(sess.data.activePlugins).toEqual(["narrator", "codex"]);
    expect(sess.data.preGameCompleted).toEqual(["pregame"]);
    // Auto-generated schema lists every session field.
    expect(sess.schema.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "id",
        "worldId",
        "turnCount",
        "status",
        "activePlugins",
      ]),
    );
  });

  it("groups plugin_data rows by pluginId+namespace into virtual tables", async () => {
    const now = new Date().toISOString();
    await store.setPluginDataBatch([
      {
        id: "pd-1",
        sessionId,
        pluginId: "codex",
        namespace: "entries",
        key: "codex-1",
        value: { title: "百灵沼泽" },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pd-2",
        sessionId,
        pluginId: "codex",
        namespace: "entries",
        key: "codex-2",
        value: { title: "兽皮地图" },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "pd-3",
        sessionId,
        pluginId: "guide",
        namespace: "message",
        key: "topic",
        value: "子时出发",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await app.request(`/api/sessions/${sessionId}/state`);
    const body = (await res.json()) as {
      tables: Record<
        string,
        {
          data: Record<string, unknown>;
          schema: { fields: { name: string }[] };
        }
      >;
    };

    const codex = body.tables["plugin_data/codex:entries"];
    expect(codex).toBeDefined();
    expect(Object.keys(codex.data).sort()).toEqual(["codex-1", "codex-2"]);
    expect((codex.data["codex-1"] as Record<string, unknown>).title).toBe(
      "百灵沼泽",
    );

    const guide = body.tables["plugin_data/guide:message"];
    expect(guide).toBeDefined();
    expect(guide.data.topic).toBe("子时出发");
  });

  it("exposes characters when any exist", async () => {
    const now = new Date().toISOString();
    await store.upsertCharacter({
      id: "char-1",
      sessionId,
      type: "player",
      name: "张三",
      fields: { hp: 100, background: "外门弟子" },
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/sessions/${sessionId}/state`);
    const body = (await res.json()) as {
      tables: Record<string, { data: Record<string, unknown> }>;
    };

    const chars = body.tables.characters;
    expect(chars).toBeDefined();
    expect((chars.data["char-1"] as Record<string, unknown>).name).toBe("张三");
  });

  it("omits characters table when session has no characters", async () => {
    const res = await app.request(`/api/sessions/${sessionId}/state`);
    const body = (await res.json()) as { tables: Record<string, unknown> };
    expect(body.tables.characters).toBeUndefined();
  });

  it("returns plugin_data table names in stable alphabetical order", async () => {
    const now = new Date().toISOString();
    await store.setPluginDataBatch([
      {
        id: "a",
        sessionId,
        pluginId: "core-z",
        namespace: "a",
        key: "k",
        value: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "b",
        sessionId,
        pluginId: "core-a",
        namespace: "a",
        key: "k",
        value: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "c",
        sessionId,
        pluginId: "core-a",
        namespace: "z",
        key: "k",
        value: 3,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await app.request(`/api/sessions/${sessionId}/state`);
    const body = (await res.json()) as { tables: Record<string, unknown> };
    const pluginTables = Object.keys(body.tables)
      .filter((n) => n.startsWith("plugin_data/"))
      .sort();
    expect(pluginTables).toEqual([
      "plugin_data/core-a:a",
      "plugin_data/core-a:z",
      "plugin_data/core-z:a",
    ]);
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.request(`/api/sessions/does-not-exist/state`);
    expect(res.status).toBe(404);
  });
});
