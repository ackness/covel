/**
 * Session routes — RESTful CRUD + session-scoped plugin management.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET    /api/sessions                      — list sessions (optional ?worldId= filter)
 *   POST   /api/sessions                      — create a new session
 *   GET    /api/sessions/:id                  — get session by ID
 *   PATCH  /api/sessions/:id                  — update session fields
 *   DELETE /api/sessions/:id                  — delete session
 *   GET    /api/sessions/:id/plugins          — list active + available plugins
 *   POST   /api/sessions/:id/plugins/enable   — enable a plugin
 *   POST   /api/sessions/:id/plugins/disable  — disable a plugin
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, MediaStore, SessionRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { HookPipeline } from "@covel/runtime";
import {
  buildSessionSnapshot,
  runSessionStartHook,
  runSessionEndHook,
  runWithHookScope,
} from "@covel/runtime";
import { errorBody } from "../../api-error.js";
import { signMediaTokenForSession } from "../../middleware/media-token.js";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
  importWorldDataForSession,
} from "../../world-data/session-import.js";
import {
  decorateSessionList,
  withEmbeddingMetadata,
} from "./session/embedding.js";
import { resolveSessionParam } from "./session/session-guard.js";
import {
  buildAvailablePluginList,
  buildSnapshotPluginList,
  findWorldDataProviderPluginId,
  isRequiredCorePlugin,
  resolveEnabledSessionPlugins,
  resolveSessionPlugins,
  unknownPluginIds,
} from "./session/plugins.js";
import {
  buildSessionPatchUpdates,
  parseCreateSessionBody,
} from "./session/request-helpers.js";
import { importWorldCharacterBlueprints } from "./session/world-character-blueprints.js";

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    mediaStore?: MediaStore;
    worldsDirs?: readonly string[];
    covelHome?: string;
  };
};

export const sessionRoutes = new Hono<Env>();

/**
 * Fire the SessionEnd lifecycle hook under the session's plugin scope, then
 * await an EventBus durability barrier.
 *
 * SessionEnd is observe-only: the DB mutation (end / delete) has already
 * happened, so a handler failure must never surface as a 500. We swallow and
 * log. `flush()` guarantees any audit events the handlers emitted are
 * persisted before we return — there is no later flush for a session that is
 * ending or already gone.
 */
async function fireSessionEnd(
  pipeline: HookPipeline | undefined,
  eventBus: EventBus | undefined,
  sessionId: string,
  activePlugins: readonly string[],
  reason: "ended" | "deleted",
): Promise<void> {
  try {
    await runWithHookScope({ activePluginIds: new Set(activePlugins) }, () =>
      runSessionEndHook(
        { pipeline, sessionId, turnId: "", eventBus },
        { sessionId, reason },
      ),
    );
    await eventBus?.flush();
  } catch (err) {
    console.warn(
      "[sessions] SessionEnd hook failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Collection endpoints ────────────────────────────────────────

// GET /sessions(?worldId=xxx)
sessionRoutes.get("/", async (c) => {
  const store = c.get("store");
  const worldId = c.req.query("worldId");
  const sessions = await store.listSessions();
  const filtered = worldId
    ? sessions.filter((s) => s.worldId === worldId)
    : sessions;
  // Decorate each session with embedding metadata so the archive list
  // can show RAG status badges without an extra round-trip per row.
  // listVectorModels is called once and shared across all sessions.
  const decorated = await decorateSessionList(store, filtered);
  return c.json({ items: decorated });
});

// POST /sessions
sessionRoutes.post("/", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const worldsDirs = c.get("worldsDirs");
  const covelHome = c.get("covelHome");
  const body = await c.req.json<Record<string, unknown>>();

  const parsedCreate = parseCreateSessionBody(body);
  if (!parsedCreate.ok) {
    return c.json(errorBody(parsedCreate.error), 400);
  }

  const rawWorldId = parsedCreate.worldId;
  const rawId = parsedCreate.id;
  const prefix = rawWorldId ?? "session";
  const suffix = randomUUID().slice(0, 8);
  const id = rawId ?? `${prefix}-${suffix}`;

  // Validate that every requested plugin ID exists in the global registry
  const unknownPlugins = unknownPluginIds(
    parsedCreate.requestedPlugins,
    pluginRegistry,
  );
  if (unknownPlugins.length > 0) {
    return c.json(
      errorBody(`Unknown plugin IDs: ${unknownPlugins.join(", ")}`),
      400,
    );
  }

  const plugins = resolveSessionPlugins(
    parsedCreate.requestedPlugins,
    pluginRegistry,
  );

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id,
    worldId: rawWorldId,
    locale: typeof body.locale === "string" ? body.locale : "zh-CN",
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    activePlugins: plugins,
    createdAt: now,
    updatedAt: now,
  };

  // Scoped transaction: createSession + world-data import + blueprint fallback
  // commit atomically. Writes flow through the tx-bound view (`tx`), so a
  // mid-import failure auto-rolls-back the session row — and on PostgreSQL the
  // import runs on an isolated connection instead of serializing the store.
  const importedMediaRefs = await store.withTransaction!(async (tx) => {
    await tx.createSession(session);
    const importedWorldData = await importWorldDataForSession({
      store: tx,
      mediaStore: c.get("mediaStore"),
      sessionId: id,
      worldId: rawWorldId,
      worldsDirs,
      covelHome,
      now,
      preflight: {
        activePlugins: plugins,
        registry: pluginRegistry,
      },
      deferMediaFinalize: true,
    });
    if (!importedWorldData.imported) {
      await importWorldCharacterBlueprints(tx, id, rawWorldId, now, {
        activePlugins: plugins,
        registry: pluginRegistry,
      });
    }
    return importedWorldData.mediaRefs;
  });
  try {
    await finalizeWorldDataMediaRefs({
      mediaStore: c.get("mediaStore"),
      refs: importedMediaRefs,
    });
  } catch (err) {
    await store.deleteSession(id);
    await cleanupWorldDataMediaRefs({
      mediaStore: c.get("mediaStore"),
      refs: importedMediaRefs,
    });
    throw err;
  }

  for (const pluginId of plugins) {
    if (typeof pluginId === "string" && pluginRegistry.get(pluginId)) {
      pluginRegistry.activate(pluginId, id);
    }
  }

  // SessionStart hook — session is created and plugins activated. Session
  // lifecycle has no turn, so turnId is empty. Observe-only (cannot veto).
  // Scoped to this session's active plugins so only their hooks fire.
  const startScope = {
    activePluginIds: new Set(
      plugins.filter((p): p is string => typeof p === "string"),
    ),
  };
  try {
    await runWithHookScope(startScope, () =>
      runSessionStartHook(
        {
          pipeline: c.get("hookPipeline"),
          sessionId: id,
          turnId: "",
          eventBus: c.get("eventBus"),
        },
        { sessionId: id, worldId: rawWorldId },
      ),
    );
  } catch (err) {
    // SessionStart is observe-only — a handler failure must never fail session
    // creation (the session is already committed). Log and continue.
    console.warn(
      "[sessions] SessionStart hook failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return c.json(session);
});

// ── Instance endpoints ──────────────────────────────────────────

// GET /sessions/:id/media-token?id=<mediaId>
sessionRoutes.get("/:id/media-token", async (c) => {
  const sessionId = c.req.param("id");
  const mediaId = c.req.query("id");
  if (!mediaId) {
    return c.json(
      errorBody("id query parameter is required", { code: "invalid_request" }),
      400,
    );
  }

  const mediaStore = c.get("mediaStore");
  if (!mediaStore) {
    return c.json(
      errorBody("Media store unavailable", { code: "media_store_unavailable" }),
      503,
    );
  }

  let lookup: Awaited<ReturnType<MediaStore["lookup"]>>;
  try {
    lookup = await mediaStore.lookup(mediaId);
  } catch (err) {
    console.error("[sessions/media-token] MediaStore.lookup failed:", err);
    return c.json(
      errorBody("Failed to load media metadata", {
        code: "media_lookup_failed",
      }),
      500,
    );
  }

  if (!lookup) {
    return c.json(
      errorBody("Media not found", { code: "media_not_found" }),
      404,
    );
  }

  let allowed = lookup.ownerSessionId === sessionId;
  if (!allowed) {
    try {
      allowed = await mediaStore.isReferencedBy(mediaId, sessionId);
    } catch (err) {
      console.error(
        "[sessions/media-token] MediaStore.isReferencedBy failed:",
        err,
      );
      return c.json(
        errorBody("Failed to check media access", {
          code: "media_access_check_failed",
        }),
        500,
      );
    }
  }

  if (!allowed) {
    return c.json(errorBody("Forbidden", { code: "media_forbidden" }), 403);
  }

  const token = signMediaTokenForSession(mediaId, sessionId);
  return c.json({
    url: `/api/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`,
  });
});

// GET /sessions/:id
sessionRoutes.get("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;
  return c.json(await withEmbeddingMetadata(store, session));
});

// PATCH /sessions/:id
sessionRoutes.patch("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await c.req.json<Record<string, unknown>>();
  const now = new Date().toISOString();
  const parsedPatch = buildSessionPatchUpdates(body, now);
  if (!parsedPatch.ok) {
    return c.json(errorBody(parsedPatch.error), 400);
  }
  const updates = parsedPatch.updates;

  await store.updateSession(id, updates);

  // SessionEnd hook — fire only on the transition into `ended` (not on repeat
  // patches of an already-ended session).
  if (updates.status === "ended" && session.status !== "ended") {
    await fireSessionEnd(
      c.get("hookPipeline"),
      c.get("eventBus"),
      id,
      session.activePlugins ?? [],
      "ended",
    );
  }

  // Return merged result to avoid a second DB read
  return c.json({ ...session, ...updates });
});

// DELETE /sessions/:id
sessionRoutes.delete("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;
  await store.deleteSession(id);

  // SessionEnd hook — session removed. `session` is read above for the guard.
  if (session.status !== "ended") {
    await fireSessionEnd(
      c.get("hookPipeline"),
      c.get("eventBus"),
      id,
      session.activePlugins ?? [],
      "deleted",
    );
  }

  return c.json({ deleted: true });
});

// ── Session plugin management ───────────────────────────────────

// GET /sessions/:id/plugins
sessionRoutes.get("/:id/plugins", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const active = [...(session.activePlugins ?? [])];
  const available = buildAvailablePluginList(active, pluginRegistry);

  return c.json({ active, available });
});

// POST /sessions/:id/plugins/enable
sessionRoutes.post("/:id/plugins/enable", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await c.req.json<{ pluginId: string }>();
  if (!body.pluginId || !pluginRegistry.get(body.pluginId)) {
    return c.json(errorBody(`Plugin "${body.pluginId}" not found`), 404);
  }

  const active = resolveEnabledSessionPlugins(
    session.activePlugins ?? [],
    body.pluginId,
    pluginRegistry,
  );
  for (const activePluginId of active) {
    pluginRegistry.activate(activePluginId, id);
  }
  for (const previousPluginId of session.activePlugins ?? []) {
    if (!active.includes(previousPluginId)) {
      pluginRegistry.deactivate(previousPluginId, id);
    }
  }
  await store.updateSession(id, {
    activePlugins: active,
    updatedAt: new Date().toISOString(),
  });
  return c.json({ ok: true, active });
});

// POST /sessions/:id/plugins/disable
sessionRoutes.post("/:id/plugins/disable", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await c.req.json<{ pluginId: string }>();
  if (!body.pluginId || typeof body.pluginId !== "string") {
    return c.json(errorBody("pluginId is required"), 400);
  }

  // Core plugin protection combines framework-owned trust source metadata
  // with manifest.pluginType. Keep IDs data-driven per the framework-plugin
  // isolation rule.
  const entry = pluginRegistry.get(body.pluginId);
  if (entry && isRequiredCorePlugin(entry)) {
    return c.json(
      errorBody(`Cannot disable core plugin "${body.pluginId}"`),
      403,
    );
  }

  pluginRegistry.deactivate(body.pluginId, id);
  const active = (session.activePlugins ?? []).filter(
    (p) => p !== body.pluginId,
  );
  await store.updateSession(id, {
    activePlugins: active,
    updatedAt: new Date().toISOString(),
  });
  return c.json({ ok: true, active });
});

// ── Session Snapshot (restore/reconnection) ────────────────────

// GET /sessions/:id/snapshot — complete session state for client restore
sessionRoutes.get("/:id/snapshot", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");

  const snapshot = await buildSessionSnapshot(store, id);
  if (!snapshot) {
    return c.json(errorBody("Session not found"), 404);
  }

  // Populate plugins from registry + session activePlugins
  const session2 = await store.getSession(id);
  const activeIds = new Set(session2?.activePlugins ?? []);
  const pluginList = buildSnapshotPluginList(pluginRegistry, activeIds);
  (snapshot as unknown as Record<string, unknown>).plugins = pluginList;

  // Attach character attribute schema if a world-data-provider plugin exists.
  // Use session.activePlugins from DB + global registry (not in-memory activation map)
  // to survive server restarts / hot-reloads.
  const session = await store.getSession(id);
  const activePlugins = session?.activePlugins ?? [];
  const worldDataPluginId = findWorldDataProviderPluginId(
    activePlugins,
    pluginRegistry,
  );
  if (worldDataPluginId) {
    try {
      const schemaRecord = await store.getPluginData(
        id,
        worldDataPluginId,
        "schema",
        "character-attributes",
      );
      if (schemaRecord?.value) {
        return c.json({ ...snapshot, characterSchema: schemaRecord.value });
      }
    } catch {
      // Non-critical: proceed without schema
    }
  }

  return c.json(snapshot);
});
