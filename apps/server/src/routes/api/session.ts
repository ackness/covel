import { readLockedSession } from "./session/locked-mutation.js";
import {
  invalidateSessionEvents,
  sessionEventBus,
} from "./session/session-events.js";
import { withSettledSessionLock } from "./plugin-rpc/settled-request.js";
import {
  characterSchemaSchema,
  defaultSessionSeats,
  sessionContentLocale,
} from "@covel/shared";
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

import { withWritableWorld } from "./worlds/mutation-guard.js";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  isBlockingWorldRequirement,
  isDependencyRejection,
  isSetupRuntime,
  pluginHasTextIn,
} from "@covel/shared";
import {
  pluginRuntimeManifests,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type { SessionRecord } from "@covel/store";
import { SessionAlreadyExistsError } from "@covel/store/errors";
import {
  restartSessionRandom,
  runSessionStartHook,
  runWithHookScope,
} from "@covel/runtime";
import { errorBody, readJsonBody } from "../../api-error.js";
import { readPluginUserSettings } from "./plugin-user-settings.js";
import { loadSessionHookScope } from "./session/hook-scope.js";
import { normalizeLocale } from "../../lib/validators.js";
import {
  finalizeWorldDataMediaRefs,
  releaseWorldDataMediaRefs,
  applyPreparedWorldDataImportForSession,
  prepareWorldDataImportForSession,
  type WorldDataImportedMediaRef,
} from "../../world-data/session-import.js";
import { worldDataImportNotices } from "../../world-data/receiver-import.js";
import {
  decorateSessionList,
  withEmbeddingMetadata,
} from "./session/embedding.js";
import { allowsAccess, requireAccess } from "../../host-profile.js";
import {
  mintSessionOwnerToken,
  mintSessionApprovalScope,
  resolveSessionParam,
  sessionIncarnationIdentity,
  publicSessionMetadata,
  publicSessionIncarnation,
  SESSION_APPROVAL_SCOPE_KEY,
  SESSION_INCARNATION_KEY,
  SESSION_LIFECYCLE_PENDING_KEY,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "./session/session-guard.js";
import {
  resolveSessionPluginPlan,
  confirmedPluginIds,
  storedPluginSelection,
  unknownPluginIds,
  unmetRequirementMessage,
  worldRequiredContracts,
} from "./session/plugins.js";
import {
  buildSessionPatchUpdates,
  parseCreateSessionBody,
} from "./session/request-helpers.js";
import { importWorldEmbeddedLorebook } from "./session/world-lorebook.js";
import { registerSessionMediaTokenRoute } from "./session/media-token-route.js";
import { registerSessionPluginRoutes } from "./session/plugin-routes.js";
import type { SessionRouteEnv } from "./session/route-env.js";
import { registerSessionViewRoute } from "./session/view-route.js";
import { registerSessionDeleteRoute } from "./session/delete-route.js";
import { registerSessionMemoryIndexRoutes } from "./session/memory-index-route.js";
import { registerSessionSeatRoutes } from "./session/seat-routes.js";
import { registerSessionActionKindRoutes } from "./session/action-kinds.js";
import {
  fireSessionEnd,
  lifecycleLeaseIsFresh,
  readSessionLifecyclePending,
  type SessionLifecyclePending,
  withoutLifecyclePending,
} from "./session/lifecycle.js";

async function clearLifecycleMarker(
  c: Context,
  id: string,
  expectedIncarnation: string,
  lifecycle: SessionLifecyclePending,
): Promise<SessionRecord | Response> {
  const store = c.get("store");
  return c.get("sessionLock").withLock(id, async () => {
    const live = await store.getSession(id);
    if (!live) {
      return c.json(
        errorBody(`Session disappeared during ${lifecycle.event}`, {
          code: "session_incarnation_changed",
        }),
        409,
      );
    }
    if (
      sessionIncarnationIdentity(live) !== expectedIncarnation ||
      readSessionLifecyclePending(live)?.opId !== lifecycle.opId
    ) {
      return c.json(
        errorBody(`Session lifecycle changed during ${lifecycle.event}`, {
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
        (pending && pending.opId !== lifecycle.opId)
      ) {
        return c.json(
          errorBody(
            `Session lifecycle changed during ${lifecycle.event} cleanup`,
            {
              code: "session_lifecycle_changed",
            },
          ),
          409,
        );
      }
      // The session change is committed. Preserve its response (including the
      // one-time owner token on creation); a surviving marker expires and can
      // be reclaimed later.
      console.warn(
        `[sessions] failed to clear ${lifecycle.event} lifecycle marker:`,
        error instanceof Error ? error.message : String(error),
      );
      return persisted;
    }
    return { ...live, metadata, updatedAt };
  });
}

export const sessionRoutes = new Hono<SessionRouteEnv>();
registerSessionMediaTokenRoute(sessionRoutes);
registerSessionPluginRoutes(sessionRoutes);
registerSessionViewRoute(sessionRoutes);
registerSessionDeleteRoute(sessionRoutes);
registerSessionMemoryIndexRoutes(sessionRoutes);
registerSessionSeatRoutes(sessionRoutes);
registerSessionActionKindRoutes(sessionRoutes);

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
    const manifests = pluginRuntimeManifests(entry).map(
      ({ manifest }) => manifest,
    );
    for (const manifest of manifests) {
      if (isSetupRuntime(manifest)) return true;
    }
  }
  return false;
}

/**
 * Prepare a session for the wire by stripping internal metadata credentials.
 */
function sanitizeSessionForResponse<T extends SessionRecord>(
  session: T,
): T & { readonly incarnation: string } {
  return {
    ...session,
    incarnation: publicSessionIncarnation(session),
    metadata: publicSessionMetadata(session.metadata),
  };
}

// ── Collection endpoints ────────────────────────────────────────

// GET /sessions(?worldId=xxx)
sessionRoutes.get("/", async (c) => {
  // The host profile's `session.list` rule. A production MemoryStore serves
  // local-mode (browser IndexedDB) frontends, which list sessions from IDB
  // and never call this endpoint; the sessions the server holds are transient
  // copies and the only other callers would be other players, so nobody gets
  // the listing (ENABLE_DEBUG_PAGE keeps it for the /debug tooling). A hosted
  // tier has no user identity to filter by, so the listing is the operator's.
  // A refused caller gets an empty list rather than an error.
  if (!allowsAccess(c, "session.list")) {
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
  // The host profile's `session.create` rule. On hosted tiers
  // (demo/commercial) session CREATION is operator-only — otherwise any
  // anonymous caller could mint themselves a session + owner token on a
  // shared host. COVEL_DESKTOP_REST_TOKEN is the only auth primitive the
  // codebase ships, so this is a single-operator gate ONLY: full principal
  // identity, per-user tenant isolation, and quota/billing are product-level
  // work and deliberately NOT implemented here. The self tier stays open.
  const createDenied = requireAccess(c, "session.create");
  if (createDenied) return createDenied;

  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const worldsDirs = c.get("worldsDirs");
  const covelHome = c.get("covelHome");
  const decodedUserSettings = readPluginUserSettings(c);
  if (!decodedUserSettings.ok) return decodedUserSettings.response;

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

  // The session is played in a language the world has an edition for. A
  // player who asks for another one gets the world's own language, and the
  // response says so; the UI language is not affected.
  const requestedLocale = normalizeLocale(body.locale);
  const world = rawWorldId ? await store.getWorld(rawWorldId) : undefined;
  const contentLocale = sessionContentLocale(
    world ?? undefined,
    requestedLocale,
  );

  // The world is a requirer too. Its contracts are read once here and kept
  // with the session, so later resolutions need no world lookup.
  const requiredContracts = rawWorldId ? worldRequiredContracts(world) : [];
  const selection = resolveSessionPluginPlan(
    parsedCreate.requestedPlugins,
    pluginRegistry,
    { excluded: parsedCreate.excludedPlugins, requiredContracts },
  );
  // A plugin whose dependency is missing is turned off, not a reason to
  // refuse the session: it is confirmed with the rest, stays off, and the
  // player is told why (`unavailable` of the plugin list). A dependency the
  // resolver could not add (say it lost a conflict) only does that to its
  // dependents; only a plugin the player asked for can refuse the session.
  const failure = selection.rejected.find(
    (item) =>
      !["approval-required", "excluded", "default-replaced"].includes(
        item.code,
      ) &&
      !isDependencyRejection(item) &&
      (parsedCreate.requestedPlugins.includes(item.pluginId) ||
        pluginRegistry.get(item.pluginId)?.packageManifest?.plugin?.kind ===
          "core"),
  );
  if (failure)
    return c.json(
      errorBody(`Plugin ${failure.pluginId}: ${failure.reason}`, {
        code: "plugin_rejected",
        details: failure,
      }),
      400,
    );
  // A contract the world requires without an active provider never stops the
  // game: the session starts without that part, and the response names it so
  // the player is told. The prep screen shows the same list before the start.
  for (const unmet of selection.unmet.filter(isBlockingWorldRequirement))
    console.warn(
      `[sessions] world ${rawWorldId}: ${unmetRequirementMessage(unmet)}`,
    );
  const plugins = confirmedPluginIds(
    selection,
    parsedCreate.requestedPlugins,
    pluginRegistry,
  );

  if (rawWorldId) {
    const worldAccess = await withWritableWorld(
      c,
      rawWorldId,
      async () => undefined,
    );
    if (worldAccess instanceof Response) return worldAccess;
  }

  // Owner token: minted on every tier so a session created
  // locally keeps working if the deployment is later promoted to a hosted
  // tier. Only the hash is persisted; the raw token is returned once below.
  const owner = mintSessionOwnerToken();

  // A session whose active set declares a setup runtime starts in `setup`;
  // otherwise it goes straight to `playing`.
  const phase: "setup" | "playing" = sessionHasSetupRuntime(
    selection.active,
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
    // The untrusted request locale was validated above: it flows into
    // locale-variant file-path construction (world-data importer) and
    // localized prompt text, so it is never stored verbatim.
    locale: contentLocale.locale,
    status: "active",
    phase,
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: defaultSessionSeats(),
    // Persist selection; execution and lifecycle hooks use only live grants.
    activePlugins: plugins,
    createdAt: now,
    updatedAt: now,
    metadata: {
      pluginSelection: storedPluginSelection({
        requested: parsedCreate.requestedPlugins,
        excluded: parsedCreate.excludedPlugins,
        requiredContracts,
      }),
      ...(parsedCreate.loreOverride !== undefined
        ? { loreOverride: parsedCreate.loreOverride }
        : {}),
      [SESSION_OWNER_TOKEN_HASH_KEY]: owner.tokenHash,
      [SESSION_APPROVAL_SCOPE_KEY]: mintSessionApprovalScope(),
      [SESSION_INCARNATION_KEY]: randomUUID(),
      [SESSION_LIFECYCLE_PENDING_KEY]: startLifecycle,
    },
  };

  const startScope = await loadSessionHookScope({
    store,
    pluginRegistry,
    session: { ...session, activePlugins: plugins },
    userSettings: decodedUserSettings.settings,
  });

  // Planning reads world files and may run approved/builtin projection code.
  // Do that before taking the session lock or opening the DB transaction; the
  // prepared plan is immutable input to the atomic write phase below.
  const preparedWorldData = await prepareWorldDataImportForSession({
    world,
    sessionId: id,
    worldId: rawWorldId,
    worldsDirs,
    covelHome,
    mediaStore: c.get("mediaStore"),
    now,
    locale: session.locale,
    // Only plugins that run take part: a projection is plugin code.
    preflight: {
      activePlugins: selection.active,
      registry: pluginRegistry,
    },
  });
  // A file that several active plugins name is left out, and the session
  // starts without it. The log tells the world's author why.
  for (const diagnostic of preparedWorldData.diagnostics)
    if (
      diagnostic.code === "convention-collision" ||
      diagnostic.code === "dimension-provider-missing"
    )
      console.warn(`[sessions] world ${rawWorldId}: ${diagnostic.message}`);
  // Without an active dimension provider the world's dimensions are left out.
  const ignoredDimensions = preparedWorldData.imported
    ? (preparedWorldData.plan.skippedDimensions ?? [])
    : [];

  const sessionLock = c.get("sessionLock");
  // Keep the persistent commit, media finalisation and process-local registry
  // update atomic with delete/recreate. Plugin hooks run after releasing this
  // main lock: hook code may call back through the HTTP API and must be able to
  // acquire the session lock without deadlocking.
  let creationCommitted = false;
  const commitCreation = async () => {
    // Scoped transaction: createSession and the world-data import (the
    // characters among it) commit atomically. Writes flow through the tx-bound view (`tx`),
    // so a mid-import failure auto-rolls-back the session row — and on
    // PostgreSQL the import runs on an isolated connection instead of
    // serializing the store.
    let importedMediaRefs: readonly WorldDataImportedMediaRef[];
    try {
      importedMediaRefs = await store.withTransaction(async (tx) => {
        await tx.createSession(session);
        const worldForSchema = rawWorldId
          ? await tx.getWorld(rawWorldId)
          : null;
        const schema = worldForSchema?.metadata?.characterSchema;
        if (schema) {
          const parsedSchema = characterSchemaSchema.parse({
            ...(schema as Record<string, unknown>),
            version: 1,
          });
          await tx.upsertCharacterSchema({
            ...parsedSchema,
            sessionId: id,
            createdAt: now,
            updatedAt: now,
          });
        }
        const importedWorldData = await applyPreparedWorldDataImportForSession({
          store: tx,
          mediaStore: c.get("mediaStore"),
          sessionId: id,
          worldId: rawWorldId,
          now,
          prepared: preparedWorldData,
          deferMediaFinalize: true,
        });
        if (
          !importedWorldData.imported ||
          (preparedWorldData.imported && preparedWorldData.portableOnly)
        ) {
          await importWorldEmbeddedLorebook(tx, id, rawWorldId, now);
        }
        return importedWorldData.mediaRefs;
      });
      creationCommitted = true;
      // A test server may create the same session ID again after deleting it.
      restartSessionRandom(id);
    } catch (error) {
      // Media materialization intentionally happens before the transaction.
      // The outer finalizer releases this attempt's preparation claims; a
      // duplicate session request must never release the live session's refs.
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
      // The import pins go whether or not the rollback below holds: a session
      // row that survives still protects its bytes through the cleanup scan.
      creationCommitted = false;
      await store.deleteSession(id);
      if (c.get("eventBus"))
        invalidateSessionEvents(c.get("eventBus"), session);
      // This creation owns the session lifecycle lock; release only its claims.
      // Content-addressed bytes may be shared and are reclaimed by media GC.
      await c.get("mediaStore")?.releaseSession(id);
      throw err;
    }

    // Single mutation point: the authoritative activePlugins set was already
    // committed by the scoped createSession transaction above (a failed media
    // finalisation deletes the row again before reaching this line), so the
    // persist callback only re-verifies the durable state before the
    // process-local mirror is reconciled.
    await pluginRegistry.applyPersistedActivations(
      id,
      plugins,
      async () => {
        if (!(await store.getSession(id))) {
          throw new Error(`Session "${id}" vanished before plugin activation`);
        }
      },
      publicSessionIncarnation(session),
    );

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
  };
  const created = await sessionLock
    .withLock(id, () =>
      rawWorldId
        ? withWritableWorld(c, rawWorldId, commitCreation)
        : commitCreation(),
    )
    .finally(async () => {
      // Release this attempt's import pins unless the session was committed.
      if (!creationCommitted)
        await releaseWorldDataMediaRefs({
          mediaStore: c.get("mediaStore"),
          refs: preparedWorldData.imported ? preparedWorldData.mediaRefs : [],
        });
    });
  if (created instanceof Response) {
    return created;
  }

  const expectedIncarnation = sessionIncarnationIdentity(session);
  if (created.runStartHook) {
    try {
      await runWithHookScope(startScope, () =>
        runSessionStartHook(
          {
            pipeline: c.get("hookPipeline"),
            sessionId: id,
            turnId: "",
            eventBus:
              c.get("eventBus") && sessionEventBus(c.get("eventBus"), session),
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

  const responseSession = await clearLifecycleMarker(
    c,
    id,
    expectedIncarnation,
    startLifecycle,
  );
  if (responseSession instanceof Response) return responseSession;

  const untranslatedPlugins = selection.active.filter(
    (pluginId) =>
      !pluginHasTextIn(
        pluginRegistry.get(pluginId)?.languages,
        contentLocale.locale,
      ),
  );

  // World data the session started without, such as what only a community
  // plugin still waiting for approval receives. The player is told; the
  // data arrives when the plugin is enabled.
  const worldDataNotices = worldDataImportNotices(
    preparedWorldData.diagnostics,
  );

  // `ownerToken` is returned exactly once — it is never readable again
  // (only its hash is stored). Clients on hosted tiers must persist it.
  return c.json(
    {
      ...sanitizeSessionForResponse(responseSession),
      ownerToken: owner.token,
      // Present when the world has no edition in the requested language and
      // the session is in the world's own language instead.
      ...(contentLocale.changed ? { requestedLocale } : {}),
      // Active plugins with no labels in the session's language: their
      // panels show English. Never a reason to refuse the session.
      ...(untranslatedPlugins.length > 0
        ? { pluginsWithoutLocale: untranslatedPlugins }
        : {}),
      // Contracts the world requires that no active plugin provides, and
      // dimensions no active plugin stores. The session runs without them.
      ...(selection.unmet.length > 0
        ? { unmetRequirements: selection.unmet }
        : {}),
      ...(ignoredDimensions.length > 0 ? { ignoredDimensions } : {}),
      ...(worldDataNotices.length > 0 ? { worldDataNotices } : {}),
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

  const decodedUserSettings = readPluginUserSettings(c);
  if (!decodedUserSettings.ok) return decodedUserSettings.response;

  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;
  const now = new Date().toISOString();
  const parsedPatch = buildSessionPatchUpdates(body, now);
  if (!parsedPatch.ok) {
    return c.json(errorBody(parsedPatch.error), 400);
  }
  const updates = parsedPatch.updates;

  const updated = await withSettledSessionLock(c, id, async () => {
    const session = await readLockedSession({
      c,
      store,
      sessionId: id,
      expectedSession: guard.session,
      allowedStatuses: "any",
    });
    if (session instanceof Response) return session;
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

    const hookScope = fireEnd
      ? await loadSessionHookScope({
          store,
          pluginRegistry: c.get("pluginRegistry"),
          session,
          userSettings: decodedUserSettings.settings,
        })
      : undefined;

    await store.updateSession(id, persistedUpdates);

    return {
      session,
      merged: { ...session, ...persistedUpdates },
      fireEnd,
      endLifecycle,
      hookScope,
    };
  });
  if (updated instanceof Response) return updated;

  if (updated.hookScope) {
    c.get("clearSessionToolOverrides")?.(id);
    c.get("clearCompactionFailures")?.(id);
    await fireSessionEnd(
      c.get("hookPipeline"),
      c.get("eventBus") && sessionEventBus(c.get("eventBus"), updated.merged),
      id,
      updated.hookScope,
      "ended",
    );
    c.get("pluginFaults")?.forgetSession(id);
  }

  let responseSession: SessionRecord | Response = updated.merged;
  if (updated.endLifecycle) {
    responseSession = await clearLifecycleMarker(
      c,
      id,
      expectedIncarnation,
      updated.endLifecycle,
    );
  }

  if (responseSession instanceof Response) return responseSession;

  return c.json(sanitizeSessionForResponse(responseSession));
});
