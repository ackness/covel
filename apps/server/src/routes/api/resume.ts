/**
 * Resume route — resumes a suspended runtime.
 *
 * POST /api/sessions/:id/resume
 *   Body: { suspensionId: string, data: unknown }
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
// Ajv 8 ships as CJS with both `module.exports = Ajv` and `exports.default = Ajv`.
// Under NodeNext + esModuleInterop, TS sees the default-import as the module's
// namespace rather than the class constructor. The named export works cleanly.
import { Ajv, type ErrorObject } from "ajv";
import type { DataStore } from "@covel/store";
import type { PluginRegistry, LoadedRuntime } from "@covel/plugin-loader";
import type { LLMAdapter, ToolExecutor, HookPipeline } from "@covel/runtime";
import {
  finalizeExecution,
  resumeSuspendedRuntime,
  buildHookSettings,
  createTurnEmitter,
  runWithHookScope,
  saveAutoSnapshot,
} from "@covel/runtime";
import type { ExecutionContext, RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec, stageMessageOrder } from "@covel/shared";
import type { EventBus } from "@covel/events";
import { errorBody } from "../../api-error.js";
import {
  checkSessionOwner,
  resolveSessionParam,
  SESSION_DELETION_PENDING_KEY,
  sessionIncarnationIdentity,
  withLockedSessionMutation,
} from "./session/session-guard.js";
import { maybeSweepExpiredSuspensions } from "./suspension-sweep.js";
import { getCachedWorld } from "../../world-cache.js";
import {
  decodePluginUserSettingsHeader,
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "./plugin-user-settings.js";
import { buildResumeTurnExecutorDeps } from "./turn-execution-deps.js";

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

// ── JSON Schema validator (Ajv, audit 2026-04-20 finding 5) ──────
//
// Previous hand-rolled validator handled type + top-level required + shallow
// property type-checks only. It silently accepted enum violations, nested
// objects, min/max, minLength/maxLength, pattern, array items, oneOf/anyOf.
// Plugins that declare a rich resumeSchema expected full JSON Schema
// semantics, so we now compile with Ajv.
//
// Compiled validators are cached per-suspension via their schema's structural
// key to avoid compile cost on retries. Strict mode is off so plugins can use
// convenience keywords like `minimum` on string-coerced numeric inputs.
const ajv = new Ajv({ allErrors: false, strict: false });
const compiledCache = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function validateAgainstJsonSchema(
  data: unknown,
  schema: unknown,
): string | null {
  if (!schema || typeof schema !== "object") return null; // no schema = no validation

  const schemaObj = schema as object;
  let validate = compiledCache.get(schemaObj);
  if (!validate) {
    try {
      validate = ajv.compile(schemaObj as Record<string, unknown>);
      compiledCache.set(schemaObj, validate);
    } catch (err) {
      // Bad schema — log a warning and skip validation (fail open is safer
      // than blocking resume on malformed plugin metadata, but the plugin
      // author should fix this).
      // eslint-disable-next-line no-console
      console.warn(
        "[resume] resumeSchema failed to compile:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  if (validate(data)) return null;

  const errors = validate.errors ?? [];
  return errors
    .map(
      (e: ErrorObject) => `${e.instancePath || "$"} ${e.message ?? "invalid"}`,
    )
    .join("; ");
}

// ── Route ────────────────────────────────────────────────────────

resumeRoutes.post("/:id/resume", async (c) => {
  const sessionId = c.req.param("id");
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
  void maybeSweepExpiredSuspensions(store);
  const pluginRegistry = c.get("pluginRegistry");

  let body: { suspensionId?: unknown; data?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errorBody("Invalid JSON body"), 400);
  }

  const { suspensionId, data } = body;
  if (!suspensionId || typeof suspensionId !== "string") {
    return c.json(errorBody("suspensionId is required"), 400);
  }

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
  const validationError = validateAgainstJsonSchema(
    data,
    suspension.resumeSchema,
  );
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
  const activePluginIds = new Set<string>();

  let hookSettings: ReturnType<typeof buildHookSettings> | undefined;

  try {
    return await runWithHookScope(
      {
        activePluginIds,
        get settings() {
          return hookSettings;
        },
      },
      async () => {
        return sessionLock.withLock(sessionId, async () => {
          // Active gate under the lock — a paused/ended session must
          // not accept a resume (it would commit state and write history).
          const liveSession = await store.getSession(sessionId);
          if (!liveSession) {
            return c.json(
              errorBody(`Session not found: ${sessionId}`, {
                code: "session_not_found",
              }),
              404,
            );
          }
          const ownerDenied = checkSessionOwner(c, liveSession);
          if (ownerDenied) return ownerDenied;
          if (
            sessionIncarnationIdentity(liveSession) !==
            sessionIncarnationIdentity(guard.session)
          ) {
            return c.json(
              errorBody("Session was replaced while resume was waiting", {
                code: "session_incarnation_changed",
              }),
              409,
            );
          }
          if (liveSession.metadata?.[SESSION_DELETION_PENDING_KEY]) {
            return c.json(
              errorBody("Session deletion is in progress; retry DELETE", {
                code: "session_deleting",
              }),
              409,
            );
          }
          if (liveSession.status !== "active") {
            return c.json(
              errorBody(
                `session is ${liveSession.status}; it must be active to resume`,
                { code: "session_not_active" },
              ),
              409,
            );
          }

          const liveSuspension = await store.getSuspension(suspensionId);
          if (!liveSuspension || liveSuspension.sessionId !== sessionId) {
            return c.json(errorBody("Suspension not found"), 404);
          }
          if (liveSuspension.resolvedAt) {
            return c.json(errorBody("Suspension already resolved"), 409);
          }
          const liveValidationError = validateAgainstJsonSchema(
            data,
            liveSuspension.resumeSchema,
          );
          if (liveValidationError !== null) {
            return c.json(
              errorBody(
                `Resume data validation failed: ${liveValidationError}`,
              ),
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
          activePluginIds.clear();
          for (const runtime of activeRuntimes) {
            activePluginIds.add(runtime.pluginId);
          }
          const world = liveSession.worldId
            ? await getCachedWorld(store, liveSession.worldId)
            : null;
          const userSettings = mergePluginUserSettings(
            readWorldPluginSettings(world?.metadata),
            decodedUserSettings.settings,
          );
          hookSettings = buildHookSettings(activeRuntimes, userSettings);

          // Claim while holding the same lifecycle lock as resume execution and
          // suspension abandonment. This closes the delete/claim race.
          const claimed = await store.claimSuspension(suspensionId);
          if (!claimed) {
            return c.json(errorBody("Suspension already resolved"), 409);
          }
          claimAcquired = true;

          // Refresh per-session character-tool overrides only after the live
          // incarnation and activation set have been accepted.
          await prepareToolsForSession?.(sessionId);

          const result = await resumeSuspendedRuntime(
            liveSuspension,
            data,
            effectiveManifest!,
            buildResumeTurnExecutorDeps(c, emitter),
            { userSettings },
          );

          if (result.status !== "success" || !result.output) {
            await releaseClaim();
            return c.json(
              {
                ...errorBody(
                  `Resume failed: ${result.error ?? `runtime ended with status ${result.status}`}`,
                ),
                result,
              },
              500,
            );
          }

          const inheritedExecution =
            liveSuspension.pendingContinuation.executionContext;
          const hasUnresolvedSibling = inheritedExecution.logicalTurnId
            ? (await store.listSuspensions(sessionId)).some(
                (candidate) =>
                  candidate.id !== liveSuspension.id &&
                  candidate.resolvedAt === undefined &&
                  candidate.pendingContinuation.executionContext
                    .logicalTurnId === inheritedExecution.logicalTurnId,
              )
            : false;
          const resumeExecutionContext: ExecutionContext = {
            ...inheritedExecution,
            executionId: result.runId,
            origin: "resume",
            // Parallel runtimes may suspend under the same logical turn. Only
            // the final unresolved continuation owns completion.
            ...(hasUnresolvedSibling ? { countPolicy: "none" } : {}),
          };

          // Atomic finalize: proposal commit + assistant turn message + resolved
          // marker land in ONE transaction via the shared finalize primitive (the
          // runtime no longer writes them — see turn-resume.ts). Any proposal
          // failure or store error rolls back ALL of it; the claim is released so
          // the suspension stays retryable. Resume persists no
          // turn_results row of its own, so `turnIds` is empty (nothing to settle).
          const finalizeResume = async (
            s: import("@covel/store").StoreTransaction,
          ): Promise<void> => {
            const out = result.output as Record<string, unknown>;
            const narrativeContent =
              typeof out.narrativeOutput === "string"
                ? out.narrativeOutput
                : typeof out.content === "string"
                  ? out.content
                  : JSON.stringify(result.output);
            const interactionsArr = out.interactions as unknown[] | undefined;
            const pendingInput =
              interactionsArr && interactionsArr.length > 0
                ? interactionsArr
                : undefined;
            const ui = out.ui as unknown[] | undefined;
            await s.appendTurnMessage({
              id: crypto.randomUUID(),
              sessionId,
              turnId: suspension.turnId,
              sourceType: "runtime",
              sourcePluginId: effectiveManifest!.pluginId,
              sourceRuntimeId: effectiveManifest!.name,
              role: "assistant",
              name: effectiveManifest!.name,
              content: narrativeContent,
              order: stageMessageOrder(
                getRuntimeSpec(effectiveManifest!).stage,
              ),
              pendingInput,
              ui,
              createdAt: new Date().toISOString(),
            });
            await s.markSuspensionResolved(suspension.id);
          };

          // finalize owns the transaction, the commit barrier (buffered fan-out
          // flushed only after commit, dropped on rollback), and the hook scope.
          const outcome = await finalizeExecution({
            store,
            sessionId,
            executionContext: resumeExecutionContext,
            // The original suspended execution deliberately did not complete
            // its logical player turn. The final sibling resume counts it in the
            // same transaction as its proposals.
            sessionClock: { now: new Date().toISOString() },
            runtimes: [effectiveManifest!],
            results: [result],
            turnIds: [],
            activePluginIds,
            ...(hookPipeline ? { hookPipeline } : {}),
            ...(eventBus ? { eventBus } : {}),
            emitter,
            extraInTx: finalizeResume,
          });

          if (outcome.status !== "committed") {
            await releaseClaim();
            const detail =
              outcome.error ??
              outcome.failedProposals
                .map((fp) => `${fp.proposal.type}: ${fp.error}`)
                .join("; ");
            return c.json(
              errorBody(
                `Resume commit failed: ${detail}. The suspension remains unresolved and can be retried.`,
              ),
              500,
            );
          }
          claimAcquired = false;
          const events = outcome.events;

          // Announce the resume only after the transaction landed — an event
          // for a rolled-back resume would desync clients.
          eventBus?.emit({
            id: crypto.randomUUID(),
            type: "event",
            topic: "game",
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
              _subTopic: "game",
              _subType: "turn.resumed",
              sessionId,
              turnId: suspension.turnId,
              suspensionId: suspension.id,
              pluginId: effectiveManifest!.pluginId,
              runtimeId: effectiveManifest!.name,
            },
          });

          // Resume commits proposals like any other turn path, so it must leave
          // an auto snapshot behind — without this, a fork taken after a resume
          // silently misses the resumed runtime's writes. Same turnId as the
          // originating suspension so the snapshot lines up with its turn.
          // `force` bypasses the checkpoint-cadence throttle: resumes are rare
          // and this snapshot is load-bearing regardless of turn number.
          try {
            await saveAutoSnapshot({
              store,
              sessionId,
              turnId: suspension.turnId,
              force: true,
              ...(eventBus ? { eventBus } : {}),
            });
          } catch (err) {
            console.warn(
              `[resume] auto snapshot failed for session ${sessionId} turn ${suspension.turnId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }

          return c.json({ result, events });
        });
      },
    );
  } catch (err: unknown) {
    // Release the claim so legitimate retries can attempt again. The
    // runtime error propagates to the caller; the suspension is back to
    // `unresolved` and appears in subsequent `listSuspensions`.
    await releaseClaim();

    const message = err instanceof Error ? err.message : String(err);
    return c.json(errorBody(`Resume failed: ${message}`), 500);
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
      return c.json({ deleted: true, suspensionId });
    },
  });
});

// ── GET list ─────────────────────────────────────────────────────
//
resumeRoutes.get("/:id/suspensions", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  // Opportunistic, time-gated, best-effort: never blocks the listing.
  void maybeSweepExpiredSuspensions(store);

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const suspensions = await store.listSuspensions(sessionId);
  return c.json({ suspensions });
});
