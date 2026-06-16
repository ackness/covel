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
import { buildSessionSnapshot } from "@covel/runtime";
import { errorBody } from "../../api-error.js";
import { signMediaTokenForSession } from "../../middleware/media-token.js";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
  importWorldDataForSession,
  type WorldDataImportedMediaRef,
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

  let importedMediaRefs: readonly WorldDataImportedMediaRef[] = [];
  await store.beginTx();
  try {
    await store.createSession(session);
    const importedWorldData = await importWorldDataForSession({
      store,
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
    importedMediaRefs = importedWorldData.mediaRefs;
    if (!importedWorldData.imported) {
      await importWorldCharacterBlueprints(store, id, rawWorldId, now, {
        activePlugins: plugins,
        registry: pluginRegistry,
      });
    }
    await store.commitTx();
  } catch (err) {
    await store.rollbackTx();
    throw err;
  }
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
