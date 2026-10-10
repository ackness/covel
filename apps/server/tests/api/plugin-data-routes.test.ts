/**
 * Plugin Data REST API compatibility tests.
 *
 * The Web UI currently consumes GET/list. PUT/DELETE are retained as
 * management/API write endpoints and should remain compatible unless they go
 * through an explicit deprecation cycle.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type ParsedRuntimeMd,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { pluginDataRoutes } from "../../src/routes/api/plugin-data.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

function buildApp(store: DataStore, pluginRegistry: PluginRegistry): Hono {
  const app = new Hono();
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", pluginRegistry);
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", pluginDataRoutes);
  return app;
}

function makeManifest(pluginId: string): RuntimeManifest {
  return {
    name: pluginId,
    pluginId,
    runtimeType: "agent",
    description: `${pluginId} runtime`,
    trigger: { type: "manual" },
    stage: "narrative",
    tools: { builtin: [], plugin: [] },
    permissions: {},
    outputKind: "plugin",
  };
}

function registerPlugin(
  registry: PluginRegistry,
  pluginId = "test-plugin",
  pluginType: "plugin" | "core-plugin" = "plugin",
): void {
  const manifest = { ...makeManifest(pluginId), pluginType };
  const parsed: ParsedRuntimeMd = {
    runtime: { type: "agent" },
    manifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };
  registry.register({
    id: pluginId,
    summary: {
      id: pluginId,
      name: "Test Plugin",
      description: "",
      pluginType,
      runtimeCount: 1,
    },
    loadedRuntimes: new Map(),
    status: "registered",

    manifests: [parsed],
  });
}

describe("Plugin Data REST API routes", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  const sessionId = "sess-plugin-data";
  const pluginId = "test-plugin";

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registerPlugin(registry, pluginId);
    registry.syncSessionActivations(sessionId, [pluginId]);
    app = buildApp(store, registry);

    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: sessionId,
      worldId: "cloudmere",
      status: "active",
      completedPlayerTurns: 1,

      locale: "zh-CN",
      activePlugins: [pluginId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("PUT writes a value and GET returns it", async () => {
    const putRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/theme`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: { mode: "dark" } }),
      },
    );
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({
      ok: true,
      namespace: "settings",
      key: "theme",
    });

    const getRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/theme`,
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      namespace: "settings",
      key: "theme",
      value: { mode: "dark" },
    });
  });

  it("authorizes writes from persisted activations after a server restart", async () => {
    registry.syncSessionActivations(sessionId, []);

    const res = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/theme`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "dark" }),
      },
    );

    expect(res.status).toBe(200);
  });

  it("DELETE removes a value", async () => {
    await store.setPluginData({
      id: "pd-1",
      sessionId,
      pluginId,
      namespace: "entries",
      key: "k1",
      value: { hello: "world" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const delRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/entries/k1`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const getRes = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/entries/k1`,
    );
    expect(getRes.status).toBe(404);
  });

  it("PUT validates body shape and payload size", async () => {
    const missingValue = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/bad`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nope: true }),
      },
    );
    expect(missingValue.status).toBe(400);

    const tooLarge = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/large`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(262_145) }),
      },
    );
    expect(tooLarge.status).toBe(413);

    // Between the old 64 KB cap and the shared 256 KiB limit is accepted.
    const fits = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/settings/medium`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(100_000) }),
      },
    );
    expect(fits.status).toBe(200);
  });

  it("write operations require the plugin to be active in the session", async () => {
    const inactivePlugin = "inactive-plugin";
    registerPlugin(registry, inactivePlugin);

    const res = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${inactivePlugin}/settings/theme`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: true }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("GET session-wide list returns the readable rows of active plugins only", async () => {
    registerPlugin(registry, "idle-plugin");
    const now = new Date().toISOString();
    const row = (
      id: string,
      plugin: string,
      namespace: string,
      key: string,
      value: unknown,
    ) =>
      store.setPluginData({
        id,
        sessionId,
        pluginId: plugin,
        namespace,
        key,
        value,
        createdAt: now,
        updatedAt: now,
      });
    await row("pd-all-1", pluginId, "entries", "alpha", { title: "Alpha" });
    await row("pd-all-2", pluginId, "_hidden.secrets", "k", "secret");
    await row("pd-all-3", "idle-plugin", "entries", "beta", "inactive");

    const res = await app.request(`/api/sessions/${sessionId}/plugin-data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        pluginId: string;
        namespace: string;
        key: string;
        value: unknown;
      }[];
    };
    expect(
      body.items.map((i) => [i.pluginId, i.namespace, i.key, i.value]),
    ).toEqual([[pluginId, "entries", "alpha", { title: "Alpha" }]]);
  });

  it("GET session-wide list 404s for an unknown session", async () => {
    const res = await app.request(`/api/sessions/missing/plugin-data`);
    expect(res.status).toBe(404);
  });

  it("GET _index lists namespaces and keys without values", async () => {
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "pd-index-1",
      sessionId,
      pluginId,
      namespace: "entries",
      key: "alpha",
      value: { title: "Alpha" },
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: "pd-index-2",
      sessionId,
      pluginId,
      namespace: "entries",
      key: "beta",
      value: ["hidden"],
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: "pd-index-3",
      sessionId,
      pluginId,
      namespace: "settings",
      key: "theme",
      value: null,
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: "pd-index-4",
      sessionId,
      pluginId,
      namespace: "_hidden.secrets",
      key: "traitor-name",
      value: "x",
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/_index`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sessionId, pluginId });
    expect(body.namespaces).toEqual([
      {
        namespace: "entries",
        count: 2,
        latestUpdatedAt: now,
        keys: [
          {
            key: "alpha",
            createdAt: now,
            updatedAt: now,
            valueType: "object",
          },
          {
            key: "beta",
            createdAt: now,
            updatedAt: now,
            valueType: "array",
          },
        ],
      },
      {
        namespace: "settings",
        count: 1,
        latestUpdatedAt: now,
        keys: [
          {
            key: "theme",
            createdAt: now,
            updatedAt: now,
            valueType: "null",
          },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("Alpha");
    expect(JSON.stringify(body)).not.toContain("hidden");
    expect(JSON.stringify(body)).not.toContain("traitor-name");
  });
});

describe("Plugin Data write guards", () => {
  let store: DataStore;
  let registry: PluginRegistry;
  let app: Hono;
  const sessionId = "sess-guards";
  const pluginId = "test-plugin";
  const corePluginId = "world-init";

  beforeEach(async () => {
    store = createMemoryStore();
    registry = createPluginRegistry();
    registerPlugin(registry, pluginId);
    registerPlugin(registry, corePluginId, "core-plugin");
    registry.syncSessionActivations(sessionId, [pluginId, corePluginId]);
    app = buildApp(store, registry);

    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: sessionId,
      worldId: "cloudmere",
      status: "active",
      completedPlayerTurns: 1,

      locale: "zh-CN",
      activePlugins: [pluginId, corePluginId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  const put = (plugin: string, namespace: string, key: string) =>
    app.request(
      `/api/sessions/${sessionId}/plugin-data/${plugin}/${namespace}/${key}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: { forged: true } }),
      },
    );

  it.each(["_jobs", "_runtime_jobs", "_logs", "_memory", "_future"])(
    "rejects writes to reserved namespace %s",
    async (namespace) => {
      // `_jobs` drives background-job scheduling: a player-issued write there
      // could fabricate or rewrite a job record.
      const res = await put(pluginId, namespace, "job-1");
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/reserved/i);
      expect(
        await store.getPluginData(sessionId, pluginId, namespace, "job-1"),
      ).toBeFalsy();
    },
  );

  it("rejects deletes from framework-reserved `_` namespaces", async () => {
    const res = await app.request(
      `/api/sessions/${sessionId}/plugin-data/${pluginId}/_logs/entry-1`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
  });

  it("rejects writes to a core plugin's namespace", async () => {
    // A forged world-init schema entry would redefine the world's character
    // attributes for every later turn.
    const res = await put(corePluginId, "schema", "character-attributes");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/core plugin/i);
    expect(
      await store.getPluginData(
        sessionId,
        corePluginId,
        "schema",
        "character-attributes",
      ),
    ).toBeFalsy();
  });

  it("still allows ordinary plugin writes", async () => {
    const res = await put(pluginId, "entries", "k1");
    expect(res.status).toBe(200);
    expect(
      await store.getPluginData(sessionId, pluginId, "entries", "k1"),
    ).toBeDefined();
  });
});
