import { commitExecution } from "./commit-execution.js";
import { resolveMediaImageFlow } from "./media-image-flow.js";
import {
  requestJobServices,
  announceDeferredRuntimeJobs,
  withSettledExecutionLock,
} from "./plugin-rpc/settled-request.js";
import {
  enqueueDeferredRuntimeJobs,
  type QueuedRuntimeJob,
} from "./plugin-rpc/runtime-job-enqueue.js";
/**
 * Resume route — resumes a suspended runtime.
 *
 * POST /api/sessions/:id/suspensions/:suspensionId/resume
 *   Body: { data: unknown }
 *
 * Browser callers may supply `X-Provider-Keys` for request-scoped overrides.
 * Desktop callers may omit it and use the server's configured provider keys.
 *
 * Concurrency (audit 2026-04-20 findings 1 + 2):
 *   - The suspension is atomically claimed via `store.claimSuspension(id)`
 *     before entering the LLM tool loop. Concurrent requests with the same
 *     suspensionId lose the race and receive 409. This guarantees
 *     exactly-once execution of a suspended runtime.
 *   - The pipeline also runs under the injected `sessionLock` (see
 *     `env.d.ts`; historically a `withSessionLock` import, now DI-provided)
 *     so sequential resumes for the same session do not interleave with turn
 *     execution.
 *
 * Expiry: the suspension-touching routes opportunistically fire a
 * time-gated, best-effort global sweep of stale (unresolved, older-than-TTL)
 * suspensions via `maybeSweepExpiredSuspensions`; a one-time forced sweep also
 * runs at server startup (see bootstrap). Claimed / resolved records are never
 * swept. TTL via `COVEL_SUSPENSION_TTL_MS` (default 7d, 0 disables).
 */

import { Hono } from "hono";
import { trackRequestWork } from "../../application-work.js";
import { z } from "zod";
import { validateResumeData } from "../../lib/resume-schema.js";
import type { DataStore, StoreTransaction } from "@covel/store";
import type { PluginRegistry, LoadedRuntime } from "@covel/plugin-loader";
import type { LLMAdapter, ToolExecutor, HookPipeline } from "@covel/runtime";
import {
  resumeSuspendedRuntime,
  snapshotUserSettings,
  createTurnEmitter,
  runWithHookScope,
} from "@covel/runtime";
import {
  concealedRuntimeIds,
  DEFAULT_LOCALE,
  type RuntimeManifest,
  type SuspensionSummary,
} from "@covel/shared";
import type { EventBus } from "@covel/events";
import {
  errorBody,
  listBody,
  logRequestError,
  okBody,
  parseJsonBody,
} from "../../api-error.js";
import {
  resolveSessionParam,
  SESSION_DELETION_PENDING_KEY,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";
import {
  readLockedSession,
  withLockedSessionMutation,
} from "./session/locked-mutation.js";
import { maybeSweepExpiredSuspensions } from "./suspension-sweep.js";
import {
  decodePluginUserSettingsHeader,
  loadSessionPluginUserSettings,
} from "./plugin-user-settings.js";
import { buildResumeTurnExecutorDeps } from "./turn-execution-deps.js";
import { buildSessionHookScope } from "./session/hook-scope.js";

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (
      manifest: RuntimeManifest,
      locale?: string,
    ) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    resolveModel: (
      manifest: RuntimeManifest,
      apiOverride?: string,
    ) => string | undefined;
    hookPipeline?: HookPipeline;
    eventBus?: EventBus;
  };
};

export const resumeRoutes = new Hono<Env>();

// ── Route ────────────────────────────────────────────────────────

resumeRoutes.post("/:id/suspensions/:suspensionId/resume", async (c) => {
  const sessionId = c.req.param("id");
  const suspensionId = c.req.param("suspensionId");
  const store = c.get("store");
  const sessionLock = c.get("sessionLock");
  const decodedUserSettings = decodePluginUserSettingsHeader(
    c.req.header("X-Plugin-User-Settings"),
  );
  if (!decodedUserSettings.ok) {
    return c.json(
      errorBody(decodedUserSettings.error, { code: decodedUserSettings.code }),
      decodedUserSettings.status,
    );
  }
  // Opportunistic, time-gated, best-effort: never blocks the resume.
  void trackRequestWork(c, () => maybeSweepExpiredSuspensions(store));
  const pluginRegistry = c.get("pluginRegistry");

  const parsedBody = await parseJsonBody(
    c,
    z.object({ data: z.unknown() }).strict(),
  );
  if (parsedBody instanceof Response) return parsedBody;
  const { data } = parsedBody.body;

  // Verify session exists
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  // Load suspension — first pass is a cheap sanity read; the real claim
  // happens atomically below via `claimSuspension` to prevent double-resume
  // under concurrent requests (audit 2026-04-20 finding 2).
  const suspension = await store.getSuspension(suspensionId);
  if (!suspension) {
    return c.json(errorBody("Suspension not found"), 404);
  }
  if (suspension.sessionId !== sessionId) {
    return c.json(errorBody("Suspension not found"), 404);
  }
  if (suspension.resolvedAt) {
    // Already resolved OR claimed by a concurrent request.
    return c.json(errorBody("Suspension already resolved"), 409);
  }

  // Validate resume data against stored resumeSchema (Ajv — finding 5)
  const validationError = validateResumeData(data, suspension.resumeSchema);
  if (validationError !== null) {
    return c.json(
      errorBody(`Resume data validation failed: ${validationError}`),
      400,
    );
  }

  const hookPipeline = c.get("hookPipeline");
  const eventBus = c.get("eventBus");
  const prepareToolsForSession = c.get("prepareToolsForSession"); // optional — see env.d.ts

  // Per-turn trace emitter — mirrors the actions.ts wiring so resume flows
  // also populate the /debug timeline with tool / llm / message / block /
  // state / hook events. The resumed runtime reuses the original suspension's
  // turnId so trace rows line up with the originating turn.
  const emitter = createTurnEmitter({
    store,
    ...(eventBus ? { eventBus } : {}),
    sessionId,
    turnId: suspension.turnId,
    concealedRuntimeIds: concealedRuntimeIds(
      pluginRegistry.getActiveRuntimes(sessionId),
    ),
  });

  let claimAcquired = false;
  const releaseClaim = async (): Promise<void> => {
    if (!claimAcquired) return;
    try {
      await sessionLock.withLock(sessionId, async () => {
        const liveSession = await store.getSession(sessionId);
        if (
          !liveSession ||
          sessionIncarnationIdentity(liveSession) !==
            sessionIncarnationIdentity(guard.session) ||
          liveSession.metadata?.[SESSION_DELETION_PENDING_KEY]
        ) {
          return;
        }
        const current = await store.getSuspension(suspensionId);
        if (
          !current ||
          current.sessionId !== sessionId ||
          !current.resolvedAt
        ) {
          return;
        }
        await store.saveSuspension({ ...current, resolvedAt: undefined });
      });
      claimAcquired = false;
    } catch (releaseErr) {
      // eslint-disable-next-line no-console
      console.warn(
        "[resume] failed to release suspension claim after error:",
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      );
    }
  };

  // Resume + commit fire hooks outside executeTurn — establish the session
  // hook scope so a plugin's hooks only run for sessions where it is active
  // (see hooks/hook-scope.ts).
  try {
    return await withSettledExecutionLock(c, sessionId, async () => {
      c.get("requestWork")?.signal.throwIfAborted();
      // Active gate under the lock — a paused/ended session must
      // not accept a resume (it would commit state and write history).
      const liveSession = await readLockedSession({
        c,
        store,
        sessionId,
        expectedSession: guard.session,
        allowedStatuses: ["active"],
      });
      if (liveSession instanceof Response) return liveSession;

      const liveSuspension = await store.getSuspension(suspensionId);
      if (!liveSuspension || liveSuspension.sessionId !== sessionId) {
        return c.json(errorBody("Suspension not found"), 404);
      }
      if (liveSuspension.resolvedAt) {
        return c.json(errorBody("Suspension already resolved"), 409);
      }
      const liveValidationError = validateResumeData(
        data,
        liveSuspension.resumeSchema,
      );
      if (liveValidationError !== null) {
        return c.json(
          errorBody(`Resume data validation failed: ${liveValidationError}`),
          400,
        );
      }

      // Rebuild the process-local activation view from persisted truth only
      // after the lifecycle checks above. A disabled runtime cannot be
      // resumed from a stale registry snapshot.
      pluginRegistry.syncSessionActivations(
        sessionId,
        liveSession.activePlugins,
      );
      const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
      const effectiveManifest: RuntimeManifest | undefined =
        activeRuntimes.find((rt) => rt.name === liveSuspension.runtimeId);
      if (!effectiveManifest) {
        return c.json(
          errorBody(
            `Runtime "${liveSuspension.runtimeId}" not found in registry`,
          ),
          404,
        );
      }
      const userSettings = snapshotUserSettings(
        await loadSessionPluginUserSettings(
          store,
          liveSession,
          decodedUserSettings.settings,
        ),
      );
      const hookScope = buildSessionHookScope({
        pluginRegistry,
        activePluginIds: liveSession.activePlugins,
        userSettings,
      });
      return runWithHookScope(hookScope, async () => {
        // Claim while holding the same lifecycle lock as resume execution and
        // suspension abandonment. This closes the delete/claim race.
        c.get("requestWork")?.signal.throwIfAborted();
        const claimed = await store.claimSuspension(suspensionId);
        if (!claimed) {
          return c.json(errorBody("Suspension already resolved"), 409);
        }
        claimAcquired = true;

        // Refresh per-session character-tool overrides only after the live
        // incarnation and activation set have been accepted.
        await prepareToolsForSession?.(sessionId);

        const resumeDeps = {
          ...buildResumeTurnExecutorDeps(c, emitter),
          hookScope,
        };
        const execution = await resumeSuspendedRuntime(
          liveSuspension,
          data,
          effectiveManifest!,
          resumeDeps,
          { userSettings, activeRuntimes },
        );

        const { result } = execution;

        if (result.status !== "success" || !result.output) {
          await releaseClaim();
          // The runtime's own failure, the text a turn reports to the player
          // in `runtime.failed`. An exception below stays a generic 500.
          const message = `Resume failed: ${result.error ?? `runtime ended with status ${result.status}`}`;
          logRequestError(c, "[resume] runtime failed", new Error(message));
          return c.json(errorBody(message), 500);
        }

        // The resume that completes a suspended turn queues the detached
        // jobs that turn held back, inside the same commit.
        const releasedJobs = execution.commit.releasedRuntimeJobs ?? [];
        const queuedRuntimeJobs: QueuedRuntimeJob[] = [];
        const outcome = await commitExecution({
          ...(releasedJobs.length > 0
            ? {
                extraInTx: async (tx: StoreTransaction) => {
                  queuedRuntimeJobs.push(
                    ...(await enqueueDeferredRuntimeJobs(tx, {
                      sessionId,
                      session: liveSession,
                      activeRuntimes,
                      descriptors: releasedJobs,
                      locale: liveSession.locale ?? DEFAULT_LOCALE,
                      ...(userSettings ? { userSettings } : {}),
                      skipInactive: true,
                      registerCredentials: (key, maxQueueMs) => {
                        const services = requestJobServices(c);
                        if (services)
                          c.get("runtimeJobCredentials")?.register(
                            key,
                            services,
                            maxQueueMs,
                          );
                      },
                    })),
                  );
                },
              }
            : {}),
          memorySystem: c.get("memorySystem"),
          imageFlowRuntimeIds: (
            await resolveMediaImageFlow(
              store,
              c.get("pluginExtensions"),
              sessionId,
            )
          )?.assetRuntimeIds,
          signal: c.get("requestWork")?.signal,
          completion: {
            kind: "resume",
            turnId: suspension.turnId,
            suspensionId: suspension.id,
            pluginId: effectiveManifest.pluginId,
            runtimeId: effectiveManifest.name,
          },
          mediaStore: resumeDeps.mediaStore,
          onFinalized: (outcome) => {
            if (outcome.status === "committed") claimAcquired = false;
          },
          store,
          execution,
          ...(hookPipeline ? { hookPipeline } : {}),
          ...(eventBus ? { eventBus } : {}),
          emitter,
        });

        if (outcome.status !== "committed") {
          await releaseClaim();
          const detail =
            outcome.error ??
            outcome.failedProposals
              .map((fp) => `${fp.proposal.type}: ${fp.error}`)
              .join("; ");
          const message = `Resume commit failed: ${detail}. The suspension remains unresolved and can be retried.`;
          logRequestError(c, "[resume] commit failed", new Error(message));
          return c.json(errorBody(message), 500);
        }
        const events = outcome.events;
        await announceDeferredRuntimeJobs(c, queuedRuntimeJobs);

        return c.json({ result, events });
      });
    });
  } catch (err: unknown) {
    // Release the claim so legitimate retries can attempt again. The
    // runtime error propagates to the caller; the suspension is back to
    // `unresolved` and appears in subsequent `listSuspensions`.
    await releaseClaim();

    throw err;
  }
});

// ── DELETE (abandon) ─────────────────────────────────────────────

resumeRoutes.delete("/:id/suspensions/:suspensionId", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const sessionId = c.req.param("id");
  const suspensionId = c.req.param("suspensionId");
  const store = c.get("store");

  return withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId,
    expectedSession: guard.session,
    allowedStatuses: "any",
    mutate: async () => {
      const suspension = await store.getSuspension(suspensionId);
      if (!suspension || suspension.sessionId !== sessionId) {
        return c.json(errorBody("Suspension not found"), 404);
      }

      await store.deleteSuspension(suspensionId);
      return c.json(okBody({ suspensionId }));
    },
  });
});

// ── GET list ─────────────────────────────────────────────────────
//
resumeRoutes.get("/:id/suspensions", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  // Opportunistic, time-gated, best-effort: never blocks the listing.
  void trackRequestWork(c, () => maybeSweepExpiredSuspensions(store));

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const suspensions = await store.listSuspensions(sessionId);
  return c.json(
    listBody(
      suspensions.map(
        (suspension) =>
          ({
            id: suspension.id,
            sessionId: suspension.sessionId,
            turnId: suspension.turnId,
            runtimeId: suspension.runtimeId,
            pluginId: suspension.pluginId,
            reason: suspension.reason,
            resumeSchema: suspension.resumeSchema,
            createdAt: suspension.createdAt,
          }) satisfies SuspensionSummary,
      ),
    ),
  );
});
