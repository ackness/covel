/**
 * World data-sync routes — import-plan preflight, session worldData sync, and
 * session dimension re-import into plugin_data + lorebook.
 *
 *   POST /worlds/:id/world-data/preflight — read-only import plan.
 *   POST /worlds/:id/sync-data            — reconcile session worldData rows.
 *   POST /worlds/:id/sync-dimensions      — re-import dimensions into a session.
 */

import { Hono } from "hono";
import { errorBody } from "../../../api-error.js";
import {
  syncWorldDataForSession,
  preflightWorldDataForSession,
} from "../../../world-data/session-import.js";
import { type WorldEnv, formatWorldEntryContent } from "./shared.js";

export const worldDataSyncRoutes = new Hono<WorldEnv>();

// POST /worlds/:id/world-data/preflight — build a read-only import plan for a
// proposed or existing session. The caller may pass either sessionId or plugins.
worldDataSyncRoutes.post("/:id/world-data/preflight", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const worldsDirs = c.get("worldsDirs");
  const covelHome = c.get("covelHome");
  const worldId = c.req.param("id");
  const body: Record<string, unknown> = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}));
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : "preflight";
  const session =
    typeof body.sessionId === "string"
      ? await store.getSession(body.sessionId)
      : null;
  if (typeof body.sessionId === "string" && !session) {
    return c.json(errorBody("Session not found"), 404);
  }
  if (session && session.worldId !== worldId) {
    return c.json(errorBody("Session world mismatch"), 400);
  }
  const plugins = Array.isArray(body.plugins)
    ? body.plugins.filter(
        (pluginId): pluginId is string => typeof pluginId === "string",
      )
    : (session?.activePlugins ?? []);

  const result = await preflightWorldDataForSession({
    sessionId,
    worldId,
    worldsDirs,
    covelHome,
    now: new Date().toISOString(),
    preflight: {
      activePlugins: plugins,
      registry: pluginRegistry,
    },
  });

  return c.json(result);
});

// POST /worlds/:id/sync-data — reconcile a session's importer-managed
// worldData rows against the latest world package and user overrides.
worldDataSyncRoutes.post("/:id/sync-data", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const worldsDirs = c.get("worldsDirs");
  const covelHome = c.get("covelHome");
  const mediaStore = c.get("mediaStore");
  const worldId = c.req.param("id");
  const body: Record<string, unknown> = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}));
  const sessionId = body.sessionId;
  if (typeof sessionId !== "string") {
    return c.json(errorBody("sessionId (string) is required"), 400);
  }
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(errorBody("Session not found"), 404);
  }
  if (session.worldId !== worldId) {
    return c.json(errorBody("Session world mismatch"), 400);
  }

  const result = await syncWorldDataForSession({
    store,
    mediaStore,
    sessionId,
    worldId,
    worldsDirs,
    covelHome,
    now: new Date().toISOString(),
    dryRun: body.dryRun !== false,
    force: body.force === true,
    deferMediaFinalize: false,
    preflight: {
      activePlugins: session.activePlugins ?? [],
      registry: pluginRegistry,
    },
  });

  return c.json({
    imported: result.imported,
    dryRun: result.dryRun,
    diagnostics: result.diagnostics,
    planned: result.planned,
    upserted: result.upserted,
    deleted: result.deleted,
    unchanged: result.unchanged,
    conflicts: result.conflicts,
  });
});

// POST /worlds/:id/sync-dimensions — re-import world dimensions into a session's
// plugin_data and lorebook canonical entries.
worldDataSyncRoutes.post("/:id/sync-dimensions", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");

  const body = await c.req.json<Record<string, unknown>>();
  const sessionId = body.sessionId;
  if (typeof sessionId !== "string") {
    return c.json(errorBody("sessionId (string) is required"), 400);
  }

  const world = await store.getWorld(id);
  if (!world) {
    return c.json(errorBody("World not found"), 404);
  }

  const session = await store.getSession(sessionId);
  if (!session || session.worldId !== id) {
    return c.json(errorBody("Session not found or world mismatch"), 404);
  }

  // Discover world-data-provider plugin by capability (not hardcoded ID)
  const worldDataPluginId = pluginRegistry.findPluginByCapability(
    sessionId,
    "world-data-provider",
  );
  if (!worldDataPluginId) {
    return c.json(
      errorBody("No world-data-provider plugin active in session"),
      422,
    );
  }

  const meta = world.metadata as Record<string, unknown> | undefined;
  const dimensions = (meta?.dimensions ?? {}) as Record<string, unknown>;

  if (Object.keys(dimensions).length === 0) {
    return c.json(errorBody("World has no dimensions to sync"), 422);
  }

  const now = new Date().toISOString();
  const nextKeys = new Set(Object.keys(dimensions));
  const existingRecords = await store.listPluginData(
    sessionId,
    worldDataPluginId,
    "entries",
  );
  const stalePluginDataKeys = existingRecords
    .filter((record) => !nextKeys.has(record.key))
    .map((record) => record.key);
  const records = Object.entries(dimensions).map(([key, value]) => ({
    id: crypto.randomUUID(),
    sessionId,
    pluginId: worldDataPluginId,
    namespace: "entries",
    key,
    value,
    createdAt: now,
    updatedAt: now,
  }));

  for (const key of stalePluginDataKeys) {
    await store.deletePluginData(sessionId, worldDataPluginId, "entries", key);
  }
  await store.setPluginDataBatch(records);

  if (typeof store.upsertLorebookEntries === "function") {
    const lorebookRecords = Object.entries(dimensions).map(
      ([key, value], idx) => ({
        id: `world-entry:${key}`,
        sessionId,
        pluginId: worldDataPluginId,
        keys: [key],
        content: formatWorldEntryContent(key, value),
        strategy: "constant" as const,
        position: "after_char_defs",
        insertionOrder: 100 + idx * 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await store.upsertLorebookEntries(lorebookRecords);

    if (
      typeof store.listSessionLorebookEntries === "function" &&
      typeof store.deleteLorebookEntry === "function"
    ) {
      const staleLorebookEntries = (
        await store.listSessionLorebookEntries(sessionId)
      ).filter((entry) => {
        if (
          entry.pluginId !== worldDataPluginId ||
          entry.strategy !== "constant"
        )
          return false;
        if (!entry.id.startsWith("world-entry:")) return false;
        const key = entry.keys[0] ?? entry.id.slice("world-entry:".length);
        return !nextKeys.has(key);
      });
      for (const entry of staleLorebookEntries) {
        await store.deleteLorebookEntry(sessionId, entry.id);
      }
    }
  }

  return c.json({
    success: true,
    syncedKeys: Object.keys(dimensions),
    entryCount: records.length,
  });
});
