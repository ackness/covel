/**
 * World data-sync routes — import-plan preflight, session worldData sync, and
 * session dimension re-import into plugin_data + lorebook.
 *
 *   POST /worlds/:id/world-data/preflight — read-only import plan.
 *   POST /worlds/:id/sync-data            — reconcile session worldData rows.
 *   POST /worlds/:id/sync-dimensions      — re-import dimensions into a session.
 */

import { Hono } from "hono";
import { FrameworkCapability } from "@covel/shared";
import { errorBody, readJsonBody } from "../../../api-error.js";
import {
  WorldDataSyncConflictError,
  syncWorldDataForSession,
  preflightWorldDataForSession,
} from "../../../world-data/session-import.js";
import { checkSessionOwner } from "../session/session-guard.js";
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
  // Owner guard: the plan leaks session-scoped import state.
  // Hosted tiers only; no-op on self.
  if (session) {
    const denied = checkSessionOwner(c, session);
    if (denied) return denied;
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
    locale: session?.locale,
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
  // Owner guard: sync rewrites the session's worldData rows.
  const denied = checkSessionOwner(c, session);
  if (denied) return denied;
  if (session.worldId !== worldId) {
    return c.json(errorBody("Session world mismatch"), 400);
  }

  const runSyncData = () =>
    syncWorldDataForSession({
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
      locale: session.locale,
      preflight: {
        activePlugins: session.activePlugins ?? [],
        registry: pluginRegistry,
      },
    });

  // Sync rewrites the session's importer-managed rows and compares them
  // against recorded hashes. Without the session lock a turn can edit a target
  // between the conflict scan and the apply transaction, and a `force: false`
  // sync would overwrite an edit it just declared unmodified.
  const sessionLock = c.get("sessionLock");
  let result: Awaited<ReturnType<typeof syncWorldDataForSession>>;
  try {
    result = sessionLock
      ? await sessionLock.withLock(sessionId, runSyncData)
      : await runSyncData();
  } catch (err) {
    if (err instanceof WorldDataSyncConflictError) {
      return c.json(
        {
          ...errorBody(err.message),
          code: err.code,
        },
        409,
      );
    }
    throw err;
  }

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

  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;
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
  // Owner guard: dimension re-import writes the session's
  // plugin_data + lorebook.
  const denied = checkSessionOwner(c, session);
  if (denied) return denied;

  // Discover world-data-provider plugin by capability (not hardcoded ID)
  const worldDataPluginId = pluginRegistry.findPluginByCapability(
    sessionId,
    FrameworkCapability.WorldDataProvider,
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

  // Re-importing dimensions is a four-phase rewrite: delete stale plugin-data
  // rows, batch-set the new ones, upsert lorebook entries, delete stale
  // lorebook entries. Run bare, a failure between phases — or a turn
  // executing concurrently — could observe half the canonical world data
  // (e.g. entries deleted but not yet rewritten), which feeds straight into
  // the next prompt. The session lock keeps a turn from interleaving; the
  // transaction makes the four phases all-or-nothing.
  const applyDimensionSync = async (
    s: import("@covel/store").StoreTransaction | typeof store,
  ): Promise<void> => {
    const existingRecords = await s.listPluginData(
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
      await s.deletePluginData(sessionId, worldDataPluginId, "entries", key);
    }
    await s.setPluginDataBatch(records);

    if (typeof s.upsertLorebookEntries !== "function") return;

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
    await s.upsertLorebookEntries(lorebookRecords);

    if (
      typeof s.listSessionLorebookEntries !== "function" ||
      typeof s.deleteLorebookEntry !== "function"
    ) {
      return;
    }
    const staleLorebookEntries = (
      await s.listSessionLorebookEntries(sessionId)
    ).filter((entry) => {
      if (entry.pluginId !== worldDataPluginId || entry.strategy !== "constant")
        return false;
      if (!entry.id.startsWith("world-entry:")) return false;
      const key = entry.keys[0] ?? entry.id.slice("world-entry:".length);
      return !nextKeys.has(key);
    });
    for (const entry of staleLorebookEntries) {
      await s.deleteLorebookEntry(sessionId, entry.id);
    }
  };

  const runSync = async (): Promise<void> => {
    if (typeof store.withTransaction === "function") {
      await store.withTransaction(applyDimensionSync);
      return;
    }
    await applyDimensionSync(store);
  };

  const sessionLock = c.get("sessionLock");
  try {
    if (sessionLock) {
      await sessionLock.withLock(sessionId, runSync);
    } else {
      await runSync();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[sync-dimensions] failed for session ${sessionId} (world ${id}):`,
      err,
    );
    return c.json(
      errorBody(`Dimension sync failed and was rolled back: ${message}`),
      500,
    );
  }

  return c.json({
    success: true,
    syncedKeys: Object.keys(dimensions),
    entryCount: Object.keys(dimensions).length,
  });
});
