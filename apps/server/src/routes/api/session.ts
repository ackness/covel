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
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import {
  deriveLegacyClockForSession,
  isSetupRuntime,
  readRuntimeEnv,
  type SetupRuntimeState,
} from "@covel/shared";
import { getPluginTrustInfo, type PluginRegistry } from "@covel/plugin-loader";
import type {
  DataStore,
  MediaStore,
  SessionRecord,
  StoreBackend,
} from "@covel/store";
import { SessionAlreadyExistsError } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { HookPipeline } from "@covel/runtime";
import {
  buildSessionSnapshot,
  runSessionStartHook,
  runSessionEndHook,
  runWithHookScope,
} from "@covel/runtime";
import { backgroundRuntimeLockId } from "./plugin-rpc/runtime-turn.js";
import { errorBody, readJsonBody } from "../../api-error.js";
import { normalizeLocale } from "../../lib/validators.js";
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
import {
  hasOperatorToken,
  checkHostedOperator,
  isOwnerAuthEnforced,
  mintSessionOwnerToken,
  mintSessionApprovalScope,
  resolveSessionParam,
  rotateSessionApprovalScope,
  sessionIncarnationIdentity,
  sessionApprovalScope,
  publicSessionMetadata,
  SESSION_APPROVAL_SCOPE_KEY,
  SESSION_DELETION_PENDING_KEY,
  SESSION_DELETION_STARTED_AT_KEY,
  SESSION_DELETION_RETRY_KEY,
  SESSION_DELETION_END_FIRED_KEY,
  SESSION_INCARNATION_KEY,
  SESSION_LIFECYCLE_PENDING_KEY,
  SESSION_NOT_FOUND_CODE,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "./session/session-guard.js";
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
    storeBackend?: StoreBackend;
  };
};

export const sessionRoutes = new Hono<Env>();

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

async function backgroundLocksForSession(
  sessionId: string,
  store: DataStore,
): Promise<string[]> {
  const runtimeNames = new Set<string>();
  // Pending job rows are the cross-Pod source of truth. They are persisted
  // before detached work is scheduled while holding the session lock, so a
  // delete either closes admission first or observes the exact runtime lock
  // it must drain. A process-local registry can miss code loaded on another
  // Pod and therefore cannot safely drive deletion.
  for (const row of await store.listPluginDataSessionScope(sessionId)) {
    if (row.namespace !== "_jobs") continue;
    const value = row.value as {
      readonly status?: unknown;
      readonly runtimeId?: unknown;
    };
    if (value?.status === "pending" && typeof value.runtimeId === "string") {
      runtimeNames.add(value.runtimeId);
    }
  }
  return [...runtimeNames]
    .map((runtimeId) => backgroundRuntimeLockId(sessionId, runtimeId))
    .sort();
}

const SESSION_LIFECYCLE_LEASE_MS = 10 * 60 * 1000;
const SESSION_DELETION_LEASE_MS = 10 * 60 * 1000;

interface SessionLifecyclePending {
  readonly opId: string;
  readonly event: "SessionStart" | "SessionEnd";
  readonly startedAt: string;
}

function readSessionLifecyclePending(
  session: SessionRecord,
): SessionLifecyclePending | undefined {
  const raw = session.metadata?.[SESSION_LIFECYCLE_PENDING_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.opId !== "string" ||
    (value.event !== "SessionStart" && value.event !== "SessionEnd") ||
    typeof value.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    opId: value.opId,
    event: value.event,
    startedAt: value.startedAt,
  };
}

function lifecycleLeaseIsFresh(pending: SessionLifecyclePending): boolean {
  const startedAt = Date.parse(pending.startedAt);
  return (
    Number.isFinite(startedAt) &&
    Date.now() - startedAt <= SESSION_LIFECYCLE_LEASE_MS
  );
}

function withoutLifecyclePending(
  metadata: SessionRecord["metadata"],
): Record<string, unknown> {
  const { [SESSION_LIFECYCLE_PENDING_KEY]: _lifecyclePending, ...rest } =
    metadata ?? {};
  return { ...rest, [SESSION_LIFECYCLE_PENDING_KEY]: undefined };
}

function withoutDeletionControl(
  metadata: SessionRecord["metadata"],
): Record<string, unknown> {
  const {
    [SESSION_DELETION_PENDING_KEY]: _deletionPending,
    [SESSION_DELETION_STARTED_AT_KEY]: _deletionStartedAt,
    [SESSION_DELETION_RETRY_KEY]: _deletionRetry,
    [SESSION_DELETION_END_FIRED_KEY]: _deletionEndFired,
    ...rest
  } = metadata ?? {};
  return {
    ...rest,
    [SESSION_DELETION_PENDING_KEY]: undefined,
    [SESSION_DELETION_STARTED_AT_KEY]: undefined,
    [SESSION_DELETION_RETRY_KEY]: undefined,
    [SESSION_DELETION_END_FIRED_KEY]: undefined,
  };
}

/**
 * Prepare a session for the wire: (1) strip the persisted owner-token hash — an
 * internal credential check a caller has no use for — and (2) refresh the legacy
 * `turnCount` / `preGameCompleted` fields from the clock. The kernel no longer
 * writes those columns; deriving them here keeps the response shape identical
 * while the persisted columns stay frozen for old-kernel / rollback reads.
 */
function sanitizeSessionForResponse<
  T extends {
    readonly metadata?: Record<string, unknown> | null;
    readonly phase?: "setup" | "playing";
    readonly completedPlayerTurns?: number;
    readonly setupRuntimes?: Readonly<Record<string, SetupRuntimeState>>;
    readonly turnCount?: number;
    readonly preGameCompleted?: readonly string[];
  },
>(session: T): T {
  const { turnCount, preGameCompleted } = deriveLegacyClockForSession(session);
  const withClock = { ...session, turnCount, preGameCompleted };
  const metadata = withClock.metadata;
  if (!metadata) return withClock;
  return { ...withClock, metadata: publicSessionMetadata(metadata) };
}

/**
 * Keep persisted active plugins aligned with the in-memory approval gate.
 * Community server code is never restored implicitly after create/fork or a
 * process restart; the operator must enable it again for this session.
 */
function approvedActivePlugins(
  pluginIds: readonly string[],
  registry: PluginRegistry,
  gate: RpcApprovalGate | undefined,
  session?: SessionRecord,
): string[] {
  return pluginIds.filter((pluginId) => {
    const entry = registry.get(pluginId);
    const trust = getPluginTrustInfo(pluginId, entry?.source);
    return (
      trust.autoLoad ||
      Boolean(
        session &&
        gate?.hasGrant(
          session.id,
          pluginId,
          COMMUNITY_SERVER_CODE_ACTION,
          sessionApprovalScope(session, pluginId),
        ),
      )
    );
  });
}

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

  // Initialize the scheduling-redesign clock. A session whose active set
  // declares a setup runtime starts in `setup`; otherwise it goes straight to
  // `playing`. The legacy turnCount / preGameCompleted keep their initial
  // values (0 / []) — which already match the formula for a `setup` session and
  // are re-derived from the clock by the first finalize for a `playing` one, so
  // the band reads correctly from `phase` in the meantime.
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
    // Validate the untrusted locale: it flows into locale-variant file-path
    // construction (world-data importer) and localized prompt text, so an
    // invalid/attacker-controlled value must never be stored verbatim.
    locale: normalizeLocale(body.locale),
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
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
      importedMediaRefs = await store.withTransaction!(async (tx) => {
        await tx.createSession(session);
        const importedWorldData = await importWorldDataForSession({
          store: tx,
          mediaStore: c.get("mediaStore"),
          sessionId: id,
          worldId: rawWorldId,
          worldsDirs,
          covelHome,
          now,
          locale: session.locale,
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
    } catch (error) {
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
  return c.json({
    ...sanitizeSessionForResponse(responseSession),
    ownerToken: owner.token,
  });
});

// ── Instance endpoints ──────────────────────────────────────────

// GET /sessions/:id/media-token?id=<mediaId>
sessionRoutes.get("/:id/media-token", async (c) => {
  const sessionId = c.req.param("id");
  // Owner guard: minting media URLs is a session-scoped read. Hosted tiers
  // only — self/desktop keeps the historical behavior (no session-existence
  // requirement; media access is checked against the media_refs table below).
  if (isOwnerAuthEnforced()) {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
  }
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
      updated.session.activePlugins ?? [],
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

// DELETE /sessions/:id
sessionRoutes.delete("/:id", async (c) => {
  const store = c.get("store");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const expectedIncarnation = sessionIncarnationIdentity(guard.session);
  const sessionLock = c.get("sessionLock");
  const pluginRegistry = c.get("pluginRegistry");
  const clearProcessLocalState = (): void => {
    pluginRegistry.clearSession(id);
    c.get("rpcApprovalGate")?.revoke(id);
    c.get("clearSessionToolOverrides")?.(id);
  };

  // Phase 1: close the admission gate before waiting for long-running
  // detached runtimes. Rotating the persisted scope makes every Pod reject
  // new work immediately; pausing also closes trusted-plugin execution.
  const prepared = await sessionLock.withLock(id, async () => {
    const lockedGuard = await resolveSessionParam(c);
    if (!lockedGuard.ok) return lockedGuard.response;
    const session = lockedGuard.session;
    if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
      return c.json(
        errorBody("Session was replaced while DELETE was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    const existingDeletionNonce =
      session.metadata?.[SESSION_DELETION_PENDING_KEY];
    const deletionStartedAt =
      typeof session.metadata?.[SESSION_DELETION_STARTED_AT_KEY] === "string"
        ? Date.parse(session.metadata[SESSION_DELETION_STARTED_AT_KEY])
        : Number.NaN;
    const staleDeletionLease =
      Number.isFinite(deletionStartedAt) &&
      Date.now() - deletionStartedAt > SESSION_DELETION_LEASE_MS;
    const retryableDeletion =
      typeof existingDeletionNonce === "string" &&
      (session.metadata?.[SESSION_DELETION_RETRY_KEY] ===
        existingDeletionNonce ||
        staleDeletionLease);
    if (existingDeletionNonce && !retryableDeletion) {
      return c.json(
        errorBody("Session deletion is already in progress", {
          code: "session_deleting",
        }),
        409,
      );
    }
    const lifecyclePending = readSessionLifecyclePending(session);
    if (lifecyclePending && lifecycleLeaseIsFresh(lifecyclePending)) {
      return c.json(
        errorBody(
          `Session lifecycle hook ${lifecyclePending.event} is still running`,
          { code: "session_lifecycle_busy" },
        ),
        409,
      );
    }
    const runtimeLockIds = await backgroundLocksForSession(id, store);
    const deletionNonce = randomUUID();
    const skipEndHook =
      retryableDeletion &&
      session.metadata?.[SESSION_DELETION_END_FIRED_KEY] ===
        existingDeletionNonce;
    const approvalSession = {
      ...session,
      metadata: withoutDeletionControl(
        lifecyclePending
          ? withoutLifecyclePending(session.metadata)
          : session.metadata,
      ),
    };
    await store.updateSession(id, {
      ...(session.status !== "ended" ? { status: "paused" as const } : {}),
      metadata: {
        ...rotateSessionApprovalScope(approvalSession),
        [SESSION_DELETION_PENDING_KEY]: deletionNonce,
        [SESSION_DELETION_STARTED_AT_KEY]: new Date().toISOString(),
        ...(skipEndHook
          ? { [SESSION_DELETION_END_FIRED_KEY]: deletionNonce }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    });
    return { session, runtimeLockIds, deletionNonce, skipEndHook };
  });
  if (prepared instanceof Response) return prepared;

  const markDeletionRetryable = async (): Promise<void> => {
    try {
      await sessionLock.withLock(id, async () => {
        const live = await store.getSession(id);
        if (
          !live ||
          sessionIncarnationIdentity(live) !== expectedIncarnation ||
          live.metadata?.[SESSION_DELETION_PENDING_KEY] !==
            prepared.deletionNonce
        ) {
          return;
        }
        await store.updateSession(id, {
          status: "paused",
          metadata: {
            ...live.metadata,
            [SESSION_DELETION_RETRY_KEY]: prepared.deletionNonce,
          },
          updatedAt: new Date().toISOString(),
        });
      });
    } catch (recoveryError) {
      // If PostgreSQL itself is unavailable the durable startedAt lease lets
      // a later request take over after the hard expiry.
      console.warn(
        "[sessions] failed to mark DELETE retryable:",
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError),
      );
    }
  };

  const completeDeletion = async (): Promise<Response> => {
    // Phase 2: drain every detached runtime lock before removing the row. Their
    // final scope check now fails against phase 1, and all execution artefacts
    // they wrote still belong to the old row and are removed by deleteSession.
    const draining = await sessionLock.withLocks(prepared.runtimeLockIds, () =>
      sessionLock.withLock(id, async () => {
        // Check the exact deletion generation after draining every detached
        // job for this incarnation.
        const lockedGuard = await resolveSessionParam(c);
        if (!lockedGuard.ok) return lockedGuard.response;
        const session = lockedGuard.session;
        if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
          return c.json(
            errorBody("Session was replaced while DELETE was draining", {
              code: "session_incarnation_changed",
            }),
            409,
          );
        }
        if (
          session.metadata?.[SESSION_DELETION_PENDING_KEY] !==
          prepared.deletionNonce
        ) {
          return c.json(
            errorBody("Session deletion generation changed", {
              code: "session_deleting",
            }),
            409,
          );
        }
        return session;
      }),
    );
    if (draining instanceof Response) return draining;

    // Run observe-only plugin code without any advisory lock. The row remains
    // paused and deletion-marked, so hook-initiated mutations and recursive
    // lifecycle requests fail closed while same-id creation sees the tombstone.
    if (prepared.session.status !== "ended" && !prepared.skipEndHook) {
      await fireSessionEnd(
        c.get("hookPipeline"),
        c.get("eventBus"),
        id,
        prepared.session.activePlugins ?? [],
        "deleted",
      );
    }

    return sessionLock.withLock(id, async () => {
      const lockedGuard = await resolveSessionParam(c);
      if (!lockedGuard.ok) return lockedGuard.response;
      const session = lockedGuard.session;
      if (
        sessionIncarnationIdentity(session) !== expectedIncarnation ||
        session.metadata?.[SESSION_DELETION_PENDING_KEY] !==
          prepared.deletionNonce
      ) {
        return c.json(
          errorBody("Session changed before DELETE commit", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }

      if (
        prepared.session.status !== "ended" &&
        session.metadata?.[SESSION_DELETION_END_FIRED_KEY] !==
          prepared.deletionNonce
      ) {
        await store.updateSession(id, {
          metadata: {
            ...session.metadata,
            [SESSION_DELETION_END_FIRED_KEY]: prepared.deletionNonce,
          },
          updatedAt: new Date().toISOString(),
        });
      }

      try {
        await c.get("mediaStore")?.releaseSession(id);
        await store.deleteSession(id);
      } catch (error) {
        const live = await store.getSession(id);
        if (!live) {
          // PostgreSQL may report a connection error after COMMIT. An absent
          // row while this lock is held proves the delete won; purge locals.
          clearProcessLocalState();
          return c.json({ deleted: true });
        } else if (
          sessionIncarnationIdentity(live) === expectedIncarnation &&
          live.metadata?.[SESSION_DELETION_PENDING_KEY] ===
            prepared.deletionNonce
        ) {
          // The row survived. Keep it paused and deletion-marked because
          // media cleanup may already have succeeded. A separate retry nonce
          // lets exactly one later DELETE take over without reopening normal
          // mutations or firing SessionEnd twice.
          try {
            await store.updateSession(id, {
              status: "paused",
              metadata: {
                ...live.metadata,
                [SESSION_DELETION_RETRY_KEY]: prepared.deletionNonce,
              },
              updatedAt: new Date().toISOString(),
            });
          } catch (recoveryError) {
            console.warn(
              "[sessions] failed to clear deletion marker after DELETE error:",
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError),
            );
          }
        }
        throw error;
      }

      clearProcessLocalState();
      return c.json({ deleted: true });
    });
  };

  try {
    return await completeDeletion();
  } catch (error) {
    await markDeletionRetryable();
    throw error;
  }
});

// ── Session plugin management ───────────────────────────────────

// GET /sessions/:id/plugins
sessionRoutes.get("/:id/plugins", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const expectedIncarnation = sessionIncarnationIdentity(guard.session);
  return c.get("sessionLock").withLock(id, async () => {
    const lockedGuard = await resolveSessionParam(c);
    if (!lockedGuard.ok) return lockedGuard.response;
    if (
      sessionIncarnationIdentity(lockedGuard.session) !== expectedIncarnation
    ) {
      return c.json(
        errorBody("Session was replaced while the request was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (lockedGuard.session.metadata?.[SESSION_DELETION_PENDING_KEY]) {
      return c.json(
        errorBody("Session deletion is in progress", {
          code: "session_deleting",
        }),
        409,
      );
    }
    const previousActive = lockedGuard.session.activePlugins ?? [];
    const active = approvedActivePlugins(
      previousActive,
      pluginRegistry,
      c.get("rpcApprovalGate"),
      lockedGuard.session,
    );
    if (active.length !== previousActive.length) {
      await store.updateSession(id, {
        activePlugins: active,
        updatedAt: new Date().toISOString(),
      });
      for (const pluginId of previousActive) {
        if (!active.includes(pluginId)) pluginRegistry.deactivate(pluginId, id);
      }
    }
    const available = buildAvailablePluginList(active, pluginRegistry);

    return c.json({ active, available });
  });
});

// POST /sessions/:id/plugins/enable
sessionRoutes.post("/:id/plugins/enable", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const expectedIncarnation = sessionIncarnationIdentity(guard.session);
  const parsed = await readJsonBody<{ pluginId: string }>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;
  if (!body.pluginId || !pluginRegistry.get(body.pluginId)) {
    return c.json(errorBody(`Plugin "${body.pluginId}" not found`), 404);
  }

  const pluginEntry = pluginRegistry.get(body.pluginId);
  const trust = getPluginTrustInfo(body.pluginId, pluginEntry?.source);
  if (trust.source === "community") {
    const operatorDenied = checkHostedOperator(c);
    if (operatorDenied) return operatorDenied;
  }
  const approvalScope = sessionApprovalScope(guard.session, body.pluginId);
  const verdict = c.get("rpcApprovalGate").evaluate({
    sessionId: id,
    sessionScope: approvalScope,
    pluginId: body.pluginId,
    action: COMMUNITY_SERVER_CODE_ACTION,
    payload: { operation: "enable" },
    trustLevel: trust.source,
    description: `Enable server-side code for plugin ${body.pluginId}`,
  });
  if (verdict.status === "pending") {
    return c.json(
      {
        status: "approval-required",
        approvalId: verdict.approvalId,
        pending: verdict.pending,
      },
      202,
    );
  }
  if (verdict.status === "rejected") {
    return c.json(
      errorBody(
        `approval queue is full (limit ${verdict.limit}); resolve pending approvals and retry`,
      ),
      429,
    );
  }

  // Community entry modules are arbitrary plugin code and may call the HTTP
  // API. Execute them without the main session lock; the activator rechecks
  // the live persisted approval scope before importing anything, and the
  // commit below checks the same scope again.
  await c.get("activatePluginServerCode")?.(body.pluginId, id);

  return c.get("sessionLock").withLock(id, async () => {
    const lockedGuard = await resolveSessionParam(c);
    if (!lockedGuard.ok) return lockedGuard.response;
    const session = lockedGuard.session;

    if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
      return c.json(
        errorBody("Session was replaced while enable was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (
      session.status !== "active" ||
      session.metadata?.[SESSION_DELETION_PENDING_KEY]
    ) {
      return c.json(
        errorBody(`Session is ${session.status}; plugin enable refused`, {
          code: session.metadata?.[SESSION_DELETION_PENDING_KEY]
            ? "session_deleting"
            : "session_not_active",
        }),
        409,
      );
    }

    if (
      trust.source === "community" &&
      sessionApprovalScope(session, body.pluginId) !== approvalScope
    ) {
      return c.json(
        errorBody("Approval scope changed while enabling the plugin", {
          code: "approval_scope_changed",
        }),
        409,
      );
    }

    const active = resolveEnabledSessionPlugins(
      session.activePlugins ?? [],
      body.pluginId,
      pluginRegistry,
    );
    await store.updateSession(id, {
      activePlugins: active,
      updatedAt: new Date().toISOString(),
    });
    for (const activePluginId of active) {
      pluginRegistry.activate(activePluginId, id);
    }
    for (const previousPluginId of session.activePlugins ?? []) {
      if (!active.includes(previousPluginId)) {
        pluginRegistry.deactivate(previousPluginId, id);
        c.get("rpcApprovalGate")?.revoke(id, previousPluginId);
      }
    }
    return c.json({ ok: true, active });
  });
});

// POST /sessions/:id/plugins/disable
sessionRoutes.post("/:id/plugins/disable", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const expectedIncarnation = sessionIncarnationIdentity(guard.session);
  const parsed = await readJsonBody<{ pluginId: string }>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;
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

  return c.get("sessionLock").withLock(id, async () => {
    const lockedGuard = await resolveSessionParam(c);
    if (!lockedGuard.ok) return lockedGuard.response;
    const session = lockedGuard.session;

    if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
      return c.json(
        errorBody("Session was replaced while disable was waiting", {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (
      session.status !== "active" ||
      session.metadata?.[SESSION_DELETION_PENDING_KEY]
    ) {
      return c.json(
        errorBody(`Session is ${session.status}; plugin disable refused`, {
          code: session.metadata?.[SESSION_DELETION_PENDING_KEY]
            ? "session_deleting"
            : "session_not_active",
        }),
        409,
      );
    }

    const active = (session.activePlugins ?? []).filter(
      (p) => p !== body.pluginId,
    );
    await store.updateSession(id, {
      activePlugins: active,
      // Rotate the persisted plugin generation so grants cached by every
      // server process become unusable. The local revoke below only cleans
      // this process; the revision is the cross-Pod invalidation mechanism.
      metadata: rotateSessionApprovalScope(session, body.pluginId),
      updatedAt: new Date().toISOString(),
    });
    pluginRegistry.deactivate(body.pluginId, id);
    c.get("rpcApprovalGate")?.revoke(id, body.pluginId);
    return c.json({ ok: true, active });
  });
});

// ── Session Snapshot (restore/reconnection) ────────────────────

// GET /sessions/:id/snapshot — complete session state for client restore
sessionRoutes.get("/:id/snapshot", async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const id = c.req.param("id");

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const snapshot = await buildSessionSnapshot(store, id);
  if (!snapshot) {
    return c.json(
      errorBody(`Session not found: ${id}`, { code: SESSION_NOT_FOUND_CODE }),
      404,
    );
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
