/**
 * GET /api/ui-specs — discovery + materialisation cache.
 *
 * Repeated requests for a session whose plugin specs have not changed must
 * NOT re-walk + re-parse plugin files or rewrite the session's UI-spec
 * plugin_data rows. Editing a spec file must invalidate the cache so the next
 * request re-materialises.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { Hono } from "hono";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import { __resetUiSpecsCache } from "../../src/routes/misc-api/ui-specs.js";

const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const MANIFEST = `---
name: panel-plugin
description: Panel plugin
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
execution: sync
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---
`;

function spec(content: string): string {
  return JSON.stringify({
    id: "panel",
    label: { en: "Panel" },
    view: { component: "Text", props: { content } },
  });
}

interface Counters {
  batchWrites: number;
  deletes: number;
}

/** Wrap a store, counting the two write paths the sync uses. */
function countingStore(store: DataStore, counters: Counters): DataStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "setPluginDataBatch") {
        return async (...args: Parameters<DataStore["setPluginDataBatch"]>) => {
          counters.batchWrites += 1;
          return target.setPluginDataBatch(...args);
        };
      }
      if (prop === "deletePluginData") {
        return async (...args: Parameters<DataStore["deletePluginData"]>) => {
          counters.deletes += 1;
          return target.deletePluginData(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DataStore;
}

describe("GET /api/ui-specs — materialisation cache", () => {
  let dir: string;
  let specPath: string;
  let app: Hono;
  let store: DataStore;
  let registry: PluginRegistry;
  let counters: Counters;
  const sessionId = "sess-cache";

  beforeEach(async () => {
    __resetUiSpecsCache();
    dir = await mkdtemp(join(tmpdir(), "covel-uispec-cache-"));
    const pluginDir = join(dir, "panel-plugin");
    await mkdir(join(pluginDir, "ui"), { recursive: true });
    await writeFile(join(pluginDir, "PLUGIN.md"), MANIFEST, "utf-8");
    await writeFile(
      join(pluginDir, "handler.js"),
      "export default async () => ({});",
      "utf-8",
    );
    specPath = join(pluginDir, "ui", "panel.json");
    await writeFile(specPath, spec("v1"), "utf-8");

    process.env.COVEL_PLUGINS_DIR = dir;
    delete process.env.COVEL_USER_PLUGINS_DIR;

    counters = { batchWrites: 0, deletes: 0 };
    store = countingStore(createMemoryStore(), counters);
    registry = createPluginRegistry();

    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      presetId: null,
      activePlugins: ["panel-plugin"],
      createdAt: new Date().toISOString(),
    });

    app = createMiscApiRoutes(stubAi, registry, store);
  });

  afterEach(async () => {
    __resetUiSpecsCache();
    delete process.env.COVEL_PLUGINS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("materialises once and skips the DB rewrite on unchanged repeat requests", async () => {
    const first = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(first.status).toBe(200);
    expect(counters.batchWrites).toBe(1);
    const writesAfterFirst = counters.batchWrites;
    const deletesAfterFirst = counters.deletes;

    // Two more requests, no file change → no additional writes / deletes.
    await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    await app.request(`/api/ui-specs?sessionId=${sessionId}`);

    expect(counters.batchWrites).toBe(writesAfterFirst);
    expect(counters.deletes).toBe(deletesAfterFirst);

    // The response is still correct on a cache hit.
    const cached = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    const body = (await cached.json()) as {
      right: Array<{ pluginId: string }>;
    };
    expect(body.right.map((e) => e.pluginId)).toEqual(["panel-plugin"]);
  });

  it("re-materialises after a spec file changes", async () => {
    await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(counters.batchWrites).toBe(1);

    // Edit the spec (content + size change) and bump mtime to guarantee the
    // signature moves even on coarse-granularity filesystems.
    await writeFile(specPath, spec("v2-longer-content"), "utf-8");
    const future = new Date(Date.now() + 10_000);
    await utimes(specPath, future, future);

    await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(counters.batchWrites).toBe(2);
    // A changed signature clears stale rows before rewriting.
    expect(counters.deletes).toBeGreaterThan(0);
  });

  it("re-materialises when a plugin is enabled mid-session (same signature)", async () => {
    // A second plugin exists on disk but is NOT active yet. Adding it now and
    // resetting the cache makes the signature stable across the two requests
    // below, so the only thing that changes is the active set.
    const bDir = join(dir, "panel-plugin-b");
    await mkdir(join(bDir, "ui"), { recursive: true });
    await writeFile(
      join(bDir, "PLUGIN.md"),
      MANIFEST.replace("name: panel-plugin", "name: panel-plugin-b"),
      "utf-8",
    );
    await writeFile(
      join(bDir, "handler.js"),
      "export default async () => ({});",
      "utf-8",
    );
    await writeFile(join(bDir, "ui", "panel.json"), spec("b"), "utf-8");
    __resetUiSpecsCache();

    // Request 1: only plugin A is active → B is not materialised.
    await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    expect(
      await store.listPluginData(sessionId, "panel-plugin-b", "__ui_right__"),
    ).toHaveLength(0);

    // Enable B mid-session. No files changed → signature is unchanged, but the
    // active set did, so the next request must re-materialise B's rows.
    await store.updateSession(sessionId, {
      activePlugins: ["panel-plugin", "panel-plugin-b"],
    });
    const res = await app.request(`/api/ui-specs?sessionId=${sessionId}`);
    const body = (await res.json()) as { right: Array<{ pluginId: string }> };
    expect(body.right.map((e) => e.pluginId).sort()).toEqual([
      "panel-plugin",
      "panel-plugin-b",
    ]);
    expect(
      await store.listPluginData(sessionId, "panel-plugin-b", "__ui_right__"),
    ).not.toHaveLength(0);
  });
});
