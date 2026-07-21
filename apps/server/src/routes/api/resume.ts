/**
 * Resume route — resumes a suspended runtime (S4-T4).
 *
 * POST /api/sessions/:id/resume
 *   Body: { suspensionId: string, data: unknown }
 *
 * API keys are NEVER stored server-side; they must be supplied again via
 * the `X-Provider-Keys` header on this request (same as any turn call).
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
 * Expiry (S4-T4.c): the suspension-touching routes opportunistically fire a
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
  processRuntimeResult,
  resumeSuspendedRuntime,
  createTurnEmitter,
  runWithHookScope,
  saveAutoSnapshot,
} from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import type { EventBus } from "@covel/events";
import { errorBody } from "../../api-error.js";
import { resolveSessionParam } from "./session/session-guard.js";
import { maybeSweepExpiredSuspensions } from "./suspension-sweep.js";

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
  // Opportunistic, time-gated, best-effort: never blocks the resume.
  void maybeSweepExpiredSuspensions(store);
  const pluginRegistry = c.get("pluginRegistry");
  const llmAdapter = c.get("llmAdapter");
  const pluginGateway = c.get("pluginGateway");
  const pluginUtils = c.get("pluginUtils");
  const loadRuntimeFn = c.get("loadRuntimeFn");
  const toolExecutor = c.get("toolExecutor");
  const resolveModel = c.get("resolveModel");

  // Require provider keys header — API keys are never stored
  const providerKeysHeader = c.req.header("X-Provider-Keys");
  if (!providerKeysHeader) {
    return c.json(
      errorBody(
        "Missing X-Provider-Keys header (provider API keys are not stored server-side)",
      ),
      400,
    );
  }

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

  // Find the runtime manifest — first try active runtimes, then global registry
  const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
  let effectiveManifest: RuntimeManifest | undefined = activeRuntimes.find(
    (rt) => rt.name === suspension.runtimeId,
  );

  if (!effectiveManifest) {
    // The plugin may exist in the registry but not be activated for this session.
    // Search across all registered entries.
    for (const [, entry] of pluginRegistry.getAll()) {
      const manifests =
        entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
      const found = manifests.find(
        (m) => m.manifest.name === suspension.runtimeId,
      );
      if (found) {
        pluginRegistry.activate(entry.id, sessionId);
        effectiveManifest = found.manifest;
        break;
      }
    }
  }

  if (!effectiveManifest) {
    return c.json(
      errorBody(`Runtime "${suspension.runtimeId}" not found in registry`),
      404,
    );
  }

  // Atomic compare-and-swap: only the winner proceeds. Losers receive 409.
  // This must happen AFTER the cheap rejections above so that e.g. a
  // validation-failed request doesn't consume the claim slot.
  const claimed = await store.claimSuspension(suspensionId);
  if (!claimed) {
    return c.json(errorBody("Suspension already resolved"), 409);
  }

  const hookPipeline = c.get("hookPipeline");
  const eventBus = c.get("eventBus");
  const sessionLock = c.get("sessionLock");
  const prepareToolsForSession = c.get("prepareToolsForSession"); // optional — see env.d.ts

  // Same Phase 2 hook used by /actions and /turn — refresh per-session
  // character-tool overrides before the resumed runtime can call any tools.
  // Optional-chain keeps tests with hand-built DI middleware working.
  await prepareToolsForSession?.(sessionId);

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

  const releaseClaim = async (): Promise<void> => {
    try {
      await store.saveSuspension({ ...suspension, resolvedAt: undefined });
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
  // (see hooks/hook-scope.ts). Include the resumed runtime's own pluginId:
  // `activeRuntimes` was snapshotted (L184) before the on-demand `activate()`
  // above, so a runtime that was inactive at snapshot time — then activated to
  // be resumed — would otherwise have its own hooks filtered out of scope.
  const activePluginIds = new Set([
    ...activeRuntimes.map((r) => r.pluginId),
    effectiveManifest.pluginId,
  ]);

  // NOTE: the resume path does not currently apply per-plugin userSettings.
  // The resumed runtime continues from a pre-rendered prompt (so `{{ userSettings.* }}`
  // is not re-interpolated) and this route's hook scope is settings-less, so a
  // merged bucket would be dead-threaded. Supporting it (re-resolve + populate
  // the resume hook scope) is a follow-up — see plugin-configurable-surface-spec.

  try {
    return await runWithHookScope({ activePluginIds }, async () => {
      return sessionLock.withLock(sessionId, async () => {
        // Active gate under the lock — a paused/ended session must
        // not accept a resume (it would commit state and write history).
        const liveSession = await store.getSession(sessionId);
        if (
          !liveSession ||
          (liveSession.status && liveSession.status !== "active")
        ) {
          await releaseClaim();
          return c.json(
            errorBody(
              `session is ${liveSession?.status ?? "missing"}; it must be active to resume`,
            ),
            409,
          );
        }

        const result = await resumeSuspendedRuntime(
          suspension,
          data,
          effectiveManifest!,
          {
            loadRuntime: loadRuntimeFn,
            llm: llmAdapter,
            ...(pluginGateway ? { gateway: pluginGateway } : {}),
            ...(pluginUtils ? { utils: pluginUtils } : {}),
            store,
            toolExecutor,
            resolveModel,
            ...(hookPipeline ? { hookPipeline } : {}),
            ...(eventBus ? { eventBus } : {}),
            emitter,
          },
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

        const outputKind = effectiveManifest.outputKind ?? "plugin";
        // Post-commit fan-out barrier: proposals commit through the tx-bound
        // store view below, which never exposes `withTransaction` — so the
        // commit pipeline cannot buffer its externally-visible fan-out
        // (emitter events + PostStateCommit hooks) behind a transaction of its
        // own. This route owns the transaction, so it owns the barrier:
        // buffer the thunks here, flush only after `withTransaction` resolves,
        // and drop them on rollback — clients and hooks must never observe
        // "committed" for writes the rollback then undoes. Without a
        // transactional store the fallback runs unwrapped and fan-out stays
        // inline (nothing later can roll the writes back atomically anyway).
        const postCommit: Array<() => Promise<void>> = [];
        const processOpts = {
          ...(hookPipeline ? { hookPipeline } : {}),
          ...(eventBus ? { eventBus } : {}),
          emitter,
          capabilities: effectiveManifest.capabilities ?? [],
          ...(typeof store.withTransaction === "function"
            ? {
                deferPostCommit: (fn: () => Promise<void>) => {
                  postCommit.push(fn);
                },
              }
            : {}),
        };

        // Atomic finalize: proposal commit + assistant turn message +
        // resolved marker land in ONE transaction (the runtime no longer
        // writes them — see turn-resume.ts). Any proposal failure or store
        // error throws, rolling back ALL of it; the claim is released so the
        // suspension stays retryable. On stores without transactions the same
        // sequence runs unwrapped (proposal failure still precedes the
        // history/resolved writes, preserving retryability).
        const finalizeResume = async (
          s: import("@covel/store").StoreTransaction,
        ) => {
          const { events, failedProposals } = await processRuntimeResult(
            result,
            s,
            sessionId,
            outputKind,
            processOpts,
          );
          if (failedProposals.length > 0) {
            throw new Error(
              `${failedProposals.length} proposal(s) failed to commit: ` +
                failedProposals
                  .map((fp) => `${fp.proposal.type}: ${fp.error}`)
                  .join("; "),
            );
          }

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
            order: effectiveManifest!.priority ?? 500,
            pendingInput,
            ui,
            createdAt: new Date().toISOString(),
          });
          await s.markSuspensionResolved(suspension.id);
          return events;
        };

        let events;
        try {
          events =
            typeof store.withTransaction === "function"
              ? await store.withTransaction(finalizeResume)
              : await finalizeResume(store);
        } catch (err) {
          await releaseClaim();
          const message = err instanceof Error ? err.message : String(err);
          return c.json(
            errorBody(
              `Resume commit failed: ${message}. The suspension remains unresolved and can be retried.`,
            ),
            500,
          );
        }

        // Transaction landed — flush the buffered proposal fan-out in commit
        // order before announcing the resume. A failing emit/hook must not
        // fail the resume (the data IS committed), so each thunk is isolated.
        for (const fn of postCommit) {
          try {
            await fn();
          } catch (flushErr) {
            console.warn(
              "[resume] post-commit fan-out failed:",
              flushErr instanceof Error ? flushErr.message : String(flushErr),
            );
          }
        }

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
    });
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

  const suspension = await store.getSuspension(suspensionId);
  if (!suspension || suspension.sessionId !== sessionId) {
    return c.json(errorBody("Suspension not found"), 404);
  }

  await store.deleteSuspension(suspensionId);
  return c.json({ deleted: true, suspensionId });
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
