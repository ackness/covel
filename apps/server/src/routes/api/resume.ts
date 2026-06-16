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
 *   - The pipeline also runs under `withSessionLock(sessionId)` so sequential
 *     resumes for the same session do not interleave with turn execution.
 *
 * TODO(S4-T4.c): Suspension expiration / TTL cleanup is not implemented.
 * Open suspensions remain until explicitly resumed or deleted. A future
 * ticket should add a background job to expire stale suspensions.
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
} from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import type { EventBus } from "@covel/events";
import { errorBody } from "../../api-error.js";
import { resolveSessionParam } from "./session/session-guard.js";

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
    getConfigFn: (
      pluginId: string,
      runtimeId: string,
    ) => Readonly<Record<string, unknown>>;
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

  try {
    const result = await sessionLock.withLock(sessionId, () =>
      resumeSuspendedRuntime(suspension, data, effectiveManifest!, {
        loadRuntime: loadRuntimeFn,
        llm: llmAdapter,
        ...(pluginGateway ? { gateway: pluginGateway } : {}),
        ...(pluginUtils ? { utils: pluginUtils } : {}),
        getConfig: c.get("getConfigFn") ?? ((_p: string, _r: string) => ({})),
        store,
        toolExecutor,
        resolveModel,
        ...(hookPipeline ? { hookPipeline } : {}),
        ...(eventBus ? { eventBus } : {}),
        emitter,
      }),
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
    const processOpts = {
      ...(hookPipeline ? { hookPipeline } : {}),
      ...(eventBus ? { eventBus } : {}),
      emitter,
      capabilities: effectiveManifest.capabilities ?? [],
    };
    const { events } = await processRuntimeResult(
      result,
      store,
      sessionId,
      outputKind,
      processOpts,
    );

    return c.json({ result, events });
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

  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const suspensions = await store.listSuspensions(sessionId);
  return c.json({ suspensions });
});
