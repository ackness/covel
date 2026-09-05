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
 *   PUT    /api/sessions/:id/plugins/:pluginId — enable a plugin
 *   DELETE /api/sessions/:id/plugins/:pluginId — disable a plugin
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { isSetupRuntime, readRuntimeEnv } from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { SessionRecord } from "@covel/store";
import { SessionAlreadyExistsError } from "@covel/store";
import { runSessionStartHook, runWithHookScope } from "@covel/runtime";
import { errorBody, readJsonBody } from "../../api-error.js";
import { normalizeLocale } from "../../lib/validators.js";
import {
  cleanupWorldDataMediaRefs,
  finalizeWorldDataMediaRefs,
  applyPreparedWorldDataImportForSession,
  prepareWorldDataImportForSession,
  type WorldDataImportedMediaRef,
} from "../../world-data/session-import.js";
import {
  decorateSessionList,
  withEmbeddingMetadata,
} from "./session/embedding.js";
import {
  hasOperatorToken,
  isOwnerAuthEnforced,
  mintSessionOwnerToken,
  mintSessionApprovalScope,
  resolveSessionParam,
  sessionIncarnationIdentity,
  publicSessionMetadata,
  SESSION_APPROVAL_SCOPE_KEY,
  SESSION_DELETION_PENDING_KEY,
  SESSION_INCARNATION_KEY,
  SESSION_LIFECYCLE_PENDING_KEY,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "./session/session-guard.js";
import {
  approvedActivePlugins,
  resolveSessionPlugins,
  unknownPluginIds,
} from "./session/plugins.js";
import {
  buildSessionPatchUpdates,
  parseCreateSessionBody,
} from "./session/request-helpers.js";
import {
  importWorldCharacterBlueprints,
  importWorldEmbeddedLorebook,
} from "./session/world-character-blueprints.js";
import { registerSessionMediaTokenRoute } from "./session/media-token-route.js";
import { registerSessionPluginRoutes } from "./session/plugin-routes.js";
import type { SessionRouteEnv } from "./session/route-env.js";
import { registerSessionViewRoute } from "./session/view-route.js";
import { registerSessionDeleteRoute } from "./session/delete-route.js";
import {
  fireSessionEnd,
  lifecycleLeaseIsFresh,
  readSessionLifecyclePending,
  type SessionLifecyclePending,
  withoutLifecyclePending,
} from "./session/lifecycle.js";

export const sessionRoutes = new Hono<SessionRouteEnv>();
registerSessionMediaTokenRoute(sessionRoutes);
registerSessionPluginRoutes(sessionRoutes);
registerSessionViewRoute(sessionRoutes);
registerSessionDeleteRoute(sessionRoutes);

/**
 * Whether any plugin in the set declares a setup-stage runtime. Discovered by
 * the normalized `stage === "setup"` (via `isSetupRuntime`) — never by hardcoded
 * plugin id. A session with a setup runtime starts in the `setup` phase; one
 * without starts in `playing`.
 */
function sessionHasSetupRuntime(
  pluginIds: readonly string[],
  registry: PluginRegistry,
): boolean {
  for (const pluginId of pluginIds) {
    const entry = registry.get(pluginId);
    if (!entry) continue;
    const manifests =
      entry.manifests && entry.manifests.length > 0
        ? entry.manifests.map((m) => m.manifest)
        : entry.manifest
          ? [entry.manifest.manifest]
          : [];
    for (const manifest of manifests) {
      if (isSetupRuntime(manifest)) return true;
    }
  }
  return false;
}

/**
 * Prepare a session for the wire by stripping internal metadata credentials.
 */
function sanitizeSessionForResponse<
  T extends {
    readonly metadata?: Record<string, unknown> | null;
  },
>(session: T): T {
  if (!session.metadata) return session;
  return {
    ...session,
    metadata: publicSessionMetadata(session.metadata),
  };
}

// ── Collection endpoints ────────────────────────────────────────

// GET /sessions(?worldId=xxx)
sessionRoutes.get("/", async (c) => {
  // MemoryStore deployments serve local-mode (browser IndexedDB) frontends,
  // which list sessions from IDB and never call this endpoint. Sessions that
  // do exist server-side are transient copies synced up for turn execution —
  // on a shared public host the only callers of this listing would be other
  // players, so hide it. Dev / ENABLE_DEBUG_PAGE deployments keep it for the
  // /debug tooling.
  const env = readRuntimeEnv();
  const hideSharedListing =
    c.get("storeBackend") === "memory" &&
    env.nodeEnv === "production" &&
    !env.debugRoutes;
  if (hideSharedListing) {
    return c.json({ items: [] });
  }

  // Hosted tiers (demo/commercial): the listing spans every tenant's sessions
  // and there is no user identity to filter by, so it is operator-only
  // (COVEL_DESKTOP_REST_TOKEN). Per-session access uses owner tokens instead.
  if (isOwnerAuthEnforced(env.deploymentTier) && !hasOperatorToken(c)) {
    return c.json({ items: [] });
  }

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
  return c.json({ items: decorated.map(sanitizeSessionForResponse) });
});

// POST /sessions
sessionRoutes.post("/", async (c) => {
  // On hosted tiers (demo/commercial) session CREATION is
  // operator-only — otherwise any anonymous caller could mint themselves a
  // session + owner token on a shared host. COVEL_DESKTOP_REST_TOKEN is the
  // only auth primitive the codebase ships, so this is a single-operator
  // gate ONLY: full principal identity, per-user tenant isolation, and
  // quota/billing are product-level work and deliberately NOT implemented
  // here. self/desktop/dev tiers stay open (loopback is the boundary).
  if (isOwnerAuthEnforced() && !hasOperatorToken(c)) {
    return c.json(
      errorBody("Operator token required to create sessions on this tier", {
        code: "operator_token_required",
      }),
      401,
    );
  }

  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const worldsDirs = c.get("worldsDirs");
  const covelHome = c.get("covelHome");
  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;

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

  const plugins = approvedActivePlugins(
    resolveSessionPlugins(parsedCreate.requestedPlugins, pluginRegistry),
    pluginRegistry,
    c.get("rpcApprovalGate"),
  );

  // Owner token: minted on every tier so a session created
  // locally keeps working if the deployment is later promoted to a hosted
  // tier. Only the hash is persisted; the raw token is returned once below.
  const owner = mintSessionOwnerToken();

  // A session whose active set declares a setup runtime starts in `setup`;
  // otherwise it goes straight to `playing`.
  const phase: "setup" | "playing" = sessionHasSetupRuntime(
    plugins.filter((p): p is string => typeof p === "string"),
    pluginRegistry,
  )
    ? "setup"
    : "playing";

  const now = new Date().toISOString();
  const startLifecycle: SessionLifecyclePending = {
    opId: randomUUID(),
    event: "SessionStart",
    startedAt: now,
  };
  const session: SessionRecord = {
    id,
    worldId: rawWorldId,
    ...(parsedCreate.presetId ? { presetId: parsedCreate.presetId } : {}),
    // Validate the untrusted locale: it flows into locale-variant file-path
    // construction (world-data importer) and localized prompt text, so an
    // invalid/attacker-controlled value must never be stored verbatim.
    locale: normalizeLocale(body.locale),
    status: "active",
    phase,
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: plugins,
    createdAt: now,
    updatedAt: now,
    metadata: {
      [SESSION_OWNER_TOKEN_HASH_KEY]: owner.tokenHash,
      [SESSION_APPROVAL_SCOPE_KEY]: mintSessionApprovalScope(),
      [SESSION_INCARNATION_KEY]: randomUUID(),
      [SESSION_LIFECYCLE_PENDING_KEY]: startLifecycle,
    },
  };

  // Planning reads world files and may run approved/builtin projection code.
  // Do that before taking the session lock or opening the DB transaction; the
  // prepared plan is immutable input to the atomic write phase below.
  const preparedWorldData = await prepareWorldDataImportForSession({
    sessionId: id,
    worldId: rawWorldId,
    worldsDirs,
    covelHome,
    mediaStore: c.get("mediaStore"),
    now,
    locale: session.locale,
    preflight: {
      activePlugins: plugins,
      registry: pluginRegistry,
    },
  });
  const preparedMediaRefs = preparedWorldData.imported
    ? preparedWorldData.mediaRefs
    : [];

  const sessionLock = c.get("sessionLock");
  // Keep the persistent commit, media finalisation and process-local registry
  // update atomic with delete/recreate. Plugin hooks run after releasing this
  // main lock: hook code may call back through the HTTP API and must be able to
  // acquire the session lock without deadlocking.
  const created = await sessionLock.withLock(id, async () => {
    // Scoped transaction: createSession + world-data import + blueprint
    // fallback commit atomically. Writes flow through the tx-bound view (`tx`),
    // so a mid-import failure auto-rolls-back the session row — and on
    // PostgreSQL the import runs on an isolated connection instead of
    // serializing the store.
    let importedMediaRefs: readonly WorldDataImportedMediaRef[];
    try {
      importedMediaRefs = await store.withTransaction(async (tx) => {
        await tx.createSession(session);
        const importedWorldData = await applyPreparedWorldDataImportForSession({
          store: tx,
          mediaStore: c.get("mediaStore"),
          sessionId: id,
          worldId: rawWorldId,
          now,
          prepared: preparedWorldData,
          deferMediaFinalize: true,
        });
        if (!importedWorldData.imported) {
          await importWorldCharacterBlueprints(tx, id, rawWorldId, now, {
            activePlugins: plugins,
            registry: pluginRegistry,
          });
          await importWorldEmbeddedLorebook(tx, id, rawWorldId, now);
        }
        return importedWorldData.mediaRefs;
      });
    } catch (error) {
      // Media materialization intentionally happens before the transaction.
      // If createSession or a later transactional fallback fails before the
      // prepared importer can return its refs, compensate them here.
      await cleanupWorldDataMediaRefs({
        mediaStore: c.get("mediaStore"),
        refs: preparedMediaRefs,
      });
      if (error instanceof SessionAlreadyExistsError) {
        return c.json(errorBody(error.message, { code: error.code }), 409);
      }
      throw error;
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

    // The create transaction and world-media finalisation can be lengthy.
    // Start the lifecycle lease only when the hook is actually about to run,
    // otherwise another Pod could mistake a legitimate hook for a stale one.
    try {
      await store.updateSession(id, {
        metadata: {
          ...session.metadata,
          [SESSION_LIFECYCLE_PENDING_KEY]: {
            ...startLifecycle,
            startedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date().toISOString(),
      });
      return { runStartHook: true };
    } catch (error) {
      // The durable session and media are already committed. SessionStart is
      // observe-only; failing this non-critical lease refresh must not return
      // 500 and lose the only raw owner token. Skip the hook and let the final
      // cleanup below remove (or eventually expire) the original marker.
      console.warn(
        "[sessions] failed to refresh SessionStart lifecycle lease; skipping hook:",
        error instanceof Error ? error.message : String(error),
      );
      return { runStartHook: false };
    }
  });
  if (created instanceof Response) return created;

  const expectedIncarnation = sessionIncarnationIdentity(session);
  const startScope = {
    activePluginIds: new Set(
      plugins.filter((p): p is string => typeof p === "string"),
    ),
  };
  if (created.runStartHook) {
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
      console.warn(
        "[sessions] SessionStart hook failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const responseSession = await sessionLock.withLock(id, async () => {
    const live = await store.getSession(id);
    if (!live) {
      return c.json(
        errorBody("Session disappeared during SessionStart", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (
      sessionIncarnationIdentity(live) !== expectedIncarnation ||
      readSessionLifecyclePending(live)?.opId !== startLifecycle.opId
    ) {
      return c.json(
        errorBody("Session lifecycle changed during SessionStart", {
          code: "session_lifecycle_changed",
        }),
        409,
      );
    }
    const metadata = withoutLifecyclePending(live.metadata);
    const updatedAt = new Date().toISOString();
    try {
      await store.updateSession(id, { metadata, updatedAt });
    } catch (error) {
      const persisted = await store.getSession(id);
      const pending = persisted
        ? readSessionLifecyclePending(persisted)
        : undefined;
      if (
        !persisted ||
        sessionIncarnationIdentity(persisted) !== expectedIncarnation ||
        (pending && pending.opId !== startLifecycle.opId)
      ) {
        return c.json(
          errorBody("Session lifecycle changed during SessionStart cleanup", {
            code: "session_lifecycle_changed",
          }),
          409,
        );
      }
      // The session is committed and this is the only response carrying the
      // raw owner token. A non-critical lease cleanup failure must not orphan
      // the row; a surviving marker expires and can be reclaimed later.
      console.warn(
        "[sessions] failed to clear SessionStart lifecycle marker:",
        error instanceof Error ? error.message : String(error),
      );
      return persisted;
    }
    return { ...live, metadata, updatedAt };
  });
  if (responseSession instanceof Response) return responseSession;

  // `ownerToken` is returned exactly once — it is never readable again
  // (only its hash is stored). Clients on hosted tiers must persist it.
  return c.json(
    {
      ...sanitizeSessionForResponse(responseSession),
      ownerToken: owner.token,
    },
    201,
  );
});

// ── Instance endpoints ──────────────────────────────────────────

// GET /sessions/:id
sessionRoutes.get("/:id", async (c) => {
  const store = c.get("store");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const session = guard.session;
  return c.json(
    sanitizeSessionForResponse(await withEmbeddingMetadata(store, session)),
  );
});

// PATCH /sessions/:id
sessionRoutes.patch("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const expectedIncarnation = sessionIncarnationIdentity(guard.session);

  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;
  const now = new Date().toISOString();
  const parsedPatch = buildSessionPatchUpdates(body, now);
  if (!parsedPatch.ok) {
    return c.json(errorBody(parsedPatch.error), 400);
  }
  const updates = parsedPatch.updates;

  const sessionLock = c.get("sessionLock");
  const updated = await sessionLock.withLock(id, async () => {
    const lockedGuard = await resolveSessionParam(c);
    if (!lockedGuard.ok) return lockedGuard.response;
    const session = lockedGuard.session;
    if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
      return c.json(
        errorBody("Session was replaced while the request was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (session.metadata?.[SESSION_DELETION_PENDING_KEY]) {
      return c.json(
        errorBody("Session deletion is in progress; retry DELETE", {
          code: "session_deleting",
        }),
        409,
      );
    }
    if (
      session.status === "ended" &&
      updates.status !== undefined &&
      updates.status !== "ended"
    ) {
      return c.json(
        errorBody("Ended sessions cannot be reactivated", {
          code: "session_ended",
        }),
        409,
      );
    }

    const fireEnd = updates.status === "ended" && session.status !== "ended";
    const existingLifecycle = readSessionLifecyclePending(session);
    if (
      updates.status !== undefined &&
      updates.status !== session.status &&
      existingLifecycle &&
      lifecycleLeaseIsFresh(existingLifecycle)
    ) {
      return c.json(
        errorBody(
          `Session lifecycle hook ${existingLifecycle.event} is still running`,
          { code: "session_lifecycle_busy" },
        ),
        409,
      );
    }
    const endLifecycle: SessionLifecyclePending | undefined = fireEnd
      ? {
          opId: randomUUID(),
          event: "SessionEnd",
          startedAt: new Date().toISOString(),
        }
      : undefined;
    const persistedUpdates = endLifecycle
      ? {
          ...updates,
          metadata: {
            ...withoutLifecyclePending(session.metadata),
            [SESSION_LIFECYCLE_PENDING_KEY]: endLifecycle,
          },
        }
      : updates;

    await store.updateSession(id, persistedUpdates);

    return {
      session,
      merged: { ...session, ...persistedUpdates },
      fireEnd,
      endLifecycle,
    };
  });
  if (updated instanceof Response) return updated;

  if (updated.fireEnd) {
    c.get("clearSessionToolOverrides")?.(id);
    await fireSessionEnd(
      c.get("hookPipeline"),
      c.get("eventBus"),
      id,
      updated.session.activePlugins,
      "ended",
    );
  }

  let responseSession: SessionRecord | Response = updated.merged;
  if (updated.endLifecycle) {
    responseSession = await sessionLock.withLock(id, async () => {
      const live = await store.getSession(id);
      if (!live) {
        return c.json(
          errorBody("Session disappeared during SessionEnd", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (
        sessionIncarnationIdentity(live) !== expectedIncarnation ||
        readSessionLifecyclePending(live)?.opId !== updated.endLifecycle?.opId
      ) {
        return c.json(
          errorBody("Session lifecycle changed during SessionEnd", {
            code: "session_lifecycle_changed",
          }),
          409,
        );
      }
      const metadata = withoutLifecyclePending(live.metadata);
      const updatedAt = new Date().toISOString();
      try {
        await store.updateSession(id, { metadata, updatedAt });
      } catch (error) {
        const persisted = await store.getSession(id);
        const pending = persisted
          ? readSessionLifecyclePending(persisted)
          : undefined;
        if (
          !persisted ||
          sessionIncarnationIdentity(persisted) !== expectedIncarnation ||
          (pending && pending.opId !== updated.endLifecycle?.opId)
        ) {
          return c.json(
            errorBody("Session lifecycle changed during SessionEnd cleanup", {
              code: "session_lifecycle_changed",
            }),
            409,
          );
        }
        console.warn(
          "[sessions] failed to clear SessionEnd lifecycle marker:",
          error instanceof Error ? error.message : String(error),
        );
        return persisted;
      }
      return { ...live, metadata, updatedAt };
    });
  }

  if (responseSession instanceof Response) return responseSession;

  return c.json(sanitizeSessionForResponse(responseSession));
});
