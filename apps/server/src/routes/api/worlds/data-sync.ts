/**
 * World data-sync routes — import-plan preflight, session worldData sync, and
 * session dimension re-import into plugin_data + lorebook.
 *
 *   POST /worlds/:id/world-data/preflight — read-only import plan.
 *   POST /worlds/:id/sync-data            — reconcile session worldData rows.
 *   POST /worlds/:id/sync-dimensions      — re-import dimensions into a session.
 */

import { Hono } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { FrameworkCapability } from "@covel/shared";
import { errorBody, readJsonBody } from "../../../api-error.js";
import {
  prepareWorldDataSyncForSession,
  WorldDataSyncConflictError,
  syncWorldDataForSession,
  preflightWorldDataForSession,
} from "../../../world-data/session-import.js";
import {
  checkSessionOwner,
  sessionApprovalScope,
  withLockedSessionMutation,
} from "../session/session-guard.js";
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
  // An existing session's plan must describe its persisted active set. Letting
  // a request body replace it produced a plausible-but-false plan and could be
  // used to probe code/contracts for plugins that were never activated.
  const plugins = session
    ? session.activePlugins
    : Array.isArray(body.plugins)
      ? body.plugins.filter(
          (pluginId): pluginId is string => typeof pluginId === "string",
        )
      : [];

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

  const dryRun = body.dryRun !== false;
  const now = new Date().toISOString();
  const syncOptions = (liveSession: typeof session) => ({
    store,
    mediaStore,
    sessionId,
    worldId,
    worldsDirs,
    covelHome,
    now,
    dryRun,
    force: body.force === true,
    deferMediaFinalize: true,
    locale: liveSession.locale,
    preflight: {
      activePlugins: liveSession.activePlugins,
      registry: pluginRegistry,
      canExecuteProjection: (pluginId: string) =>
        c
          .get("rpcApprovalGate")
          .hasGrant(
            liveSession.id,
            pluginId,
            COMMUNITY_SERVER_CODE_ACTION,
            sessionApprovalScope(liveSession, pluginId),
          ),
    },
  });

  // Planning reads files and executes bounded projection workers. Keep that
  // expensive, non-mutating phase outside the session lock; the locked phase
  // below revalidates every session field that influenced the plan.
  const prepared = await prepareWorldDataSyncForSession(syncOptions(session));
  const runSyncData = (liveSession: typeof session) =>
    syncWorldDataForSession({
      ...syncOptions(liveSession),
      prepared,
    });
  const publicSyncResult = (
    result: Awaited<ReturnType<typeof syncWorldDataForSession>>,
  ) => ({
    imported: result.imported,
    dryRun: result.dryRun,
    diagnostics: result.diagnostics,
    planned: result.planned,
    upserted: result.upserted,
    deleted: result.deleted,
    unchanged: result.unchanged,
    conflicts: result.conflicts,
  });

  if (dryRun) {
    return c.json(publicSyncResult(await runSyncData(session)));
  }

  // Sync rewrites the session's importer-managed rows and compares them
  // against recorded hashes. Without the session lock a turn can edit a target
  // between the conflict scan and the apply transaction, and a `force: false`
  // sync would overwrite an edit it just declared unmodified.
  const sessionLock = c.get("sessionLock");
  if (!sessionLock) {
    return c.json(
      errorBody("Session mutation lock is unavailable", {
        code: "session_lock_unavailable",
      }),
      503,
    );
  }
  let result: Awaited<ReturnType<typeof syncWorldDataForSession>>;
  try {
    const locked = await withLockedSessionMutation({
      c,
      store,
      sessionLock,
      sessionId,
      expectedSession: session,
      allowedStatuses: ["active"],
      mutate: async (liveSession) => {
        if (liveSession.worldId !== worldId) {
          return c.json(errorBody("Session world mismatch"), 400);
        }
        const activePluginsUnchanged =
          liveSession.activePlugins.length === session.activePlugins.length &&
          liveSession.activePlugins.every(
            (pluginId, index) => pluginId === session.activePlugins[index],
          );
        const approvalScopesUnchanged = session.activePlugins.every(
          (pluginId) =>
            sessionApprovalScope(liveSession, pluginId) ===
            sessionApprovalScope(session, pluginId),
        );
        if (
          liveSession.locale !== session.locale ||
          !activePluginsUnchanged ||
          !approvalScopesUnchanged
        ) {
          return c.json(
            errorBody(
              "Session plugins, locale, or approval scope changed while the world-data plan was prepared",
              { code: "world_data_sync_plan_stale" },
            ),
            409,
          );
        }
        return runSyncData(liveSession);
      },
    });
    if (locked instanceof Response) return locked;
    result = locked;
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

  return c.json(publicSyncResult(result));
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
    worldDataPluginId: string,
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

  const runSync = async (
    liveSession: typeof session,
  ): Promise<Response | undefined> => {
    if (liveSession.worldId !== id) {
      return c.json(errorBody("Session not found or world mismatch"), 404);
    }
    if (typeof pluginRegistry.syncSessionActivations === "function") {
      pluginRegistry.syncSessionActivations(
        sessionId,
        liveSession.activePlugins,
      );
    }
    // Discover world-data-provider plugin by capability (not hardcoded ID)
    // only after the persisted active set has been re-read under the lock.
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
    await store.withTransaction((tx) =>
      applyDimensionSync(tx, worldDataPluginId),
    );
    return undefined;
  };

  const sessionLock = c.get("sessionLock");
  if (!sessionLock) {
    return c.json(
      errorBody("Session mutation lock is unavailable", {
        code: "session_lock_unavailable",
      }),
      503,
    );
  }
  try {
    const locked = await withLockedSessionMutation({
      c,
      store,
      sessionLock,
      sessionId,
      expectedSession: session,
      allowedStatuses: ["active"],
      mutate: runSync,
    });
    if (locked instanceof Response) return locked;
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
