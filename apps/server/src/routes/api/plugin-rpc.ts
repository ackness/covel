/**
 * PR-3: Plugin RPC route.
 *
 * Single channel for all structured plugin commands:
 *
 *   POST /api/sessions/:id/plugin-rpc
 *   {
 *     "pluginId": "codex",
 *     "action": "regenerate",     // OR runtimeId, never both
 *     "payload": { ... }
 *   }
 *
 * Two dispatch modes:
 *
 *   1. Action-level (`action` set) — delegates to an RpcActionDecl handler
 *      declared in `manifest.rpc[action]` or a framework default. Returns a
 *      single JSON response.
 *
 *   2. Runtime-level (`runtimeId` set) — invokes `executeTurn` with
 *      `input.manualTrigger` so the target runtime runs through the full
 *      turn pipeline (prompt assembly, tool loop, proposal commit) and any
 *      event-triggered downstreams fire automatically.
 *
 *      Sub-modes via `manifest.execution`:
 *        - `'sync'` (default) — awaits runtime completion, commits proposals,
 *          returns a JSON summary with the runtime results.
 *        - `'background'` (M4) — schedules work off-request and returns a
 *          jobId; progress streams via `plugin-data.changed` SSE under the
 *          reserved `_jobs` namespace.
 *
 * Resolution order for action dispatch:
 *   1. Plugin-declared action (manifest.rpc[action])
 *   2. Framework default (registry.getFrameworkDefault)
 */

import { Hono } from "hono";
import { createRpcHandlerStoreView } from "@covel/runtime";
import { RpcDispatchError, RpcValidationError } from "@covel/runtime";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { FrameworkCapability } from "@covel/shared";
import {
  decodePluginUserSettingsHeader,
  validatePluginRpcBody,
} from "./plugin-rpc/body.js";
import { createPluginRpcJobRunner } from "./plugin-rpc/background-jobs.js";
import { createPluginRpcRuntimeTurnRunner } from "./plugin-rpc/runtime-turn.js";

export const pluginRpcRoutes = new Hono();

pluginRpcRoutes.post("/:id/plugin-rpc", async (c) => {
  const store = c.get("store");
  const executor = c.get("rpcExecutor");
  const sessionId = c.req.param("id");

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(
      { status: "error", error: `Session "${sessionId}" not found` },
      404,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ status: "error", error: "invalid JSON body" }, 400);
  }

  const bodyResult = validatePluginRpcBody(rawBody);
  if (!bodyResult.ok) {
    return c.json(
      { status: "error", error: bodyResult.error },
      bodyResult.status,
    );
  }
  const body = bodyResult.body;

  // ── Runtime-level manual trigger ─────────────────────────────────
  //
  // Runs the target runtime through the full turn pipeline (prompt assembly,
  // tool loop, proposal commit) with `input.manualTrigger` set. Event-
  // triggered followers chain automatically via the executor's post-group
  // event loop.
  //
  // Execution sub-mode comes from `manifest.execution`:
  //   - `'sync'` (default) → await results, commit, return JSON.
  //   - `'background'` → enqueue a `_jobs/{jobId}` row, return 202 + {jobId},
  //     and run the turn off-request (see the background branch below). The
  //     UI tracks completion via `plugin-data.changed` SSE.
  if (body.runtimeId) {
    const pluginRegistry = c.get("pluginRegistry");
    const llmAdapter = c.get("llmAdapter");
    const pluginGateway = c.get("pluginGateway");
    const pluginUtils = c.get("pluginUtils");
    const getPluginSource = c.get("getPluginSource");
    const loadRuntimeFn = c.get("loadRuntimeFn");
    const toolExecutor = c.get("toolExecutor");
    const resolveModel = c.get("resolveModel");
    const eventBus = c.get("eventBus");
    const compactorRunner = c.get("compactorRunner");
    const hookPipeline = c.get("hookPipeline");
    const sessionLock = c.get("sessionLock");
    const mediaStore = c.get("mediaStore");
    const prepareToolsForSession = c.get("prepareToolsForSession");

    // Activate the session's plugins in the registry — idempotent but
    // required after a server restart or when this is the first request
    // for this session.
    const sessionPlugins = session.activePlugins as
      | readonly string[]
      | undefined;
    if (sessionPlugins) {
      for (const pid of sessionPlugins) {
        pluginRegistry.activate(pid, sessionId);
      }
    }

    const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
    const target = activeRuntimes.find((rt) => rt.name === body.runtimeId);
    if (!target) {
      return c.json(
        {
          status: "error",
          error: `runtime "${body.runtimeId}" not active in session ${sessionId}`,
          code: "runtime-not-active",
        },
        404,
      );
    }
    if (target.pluginId !== body.pluginId) {
      return c.json(
        {
          status: "error",
          error: `runtime "${body.runtimeId}" belongs to plugin "${target.pluginId}", not "${body.pluginId}"`,
          code: "plugin-mismatch",
        },
        400,
      );
    }

    // Approval gate — trust comes from plugin discovery source, NOT from
    // the manifest's `pluginType` field. `pluginType` is author-supplied and
    // could be forged by a third-party plugin claiming `core-plugin` to
    // auto-bypass approval. `entry.source` is set by bootstrap from the
    // discovery pipeline, which clamps non-first-dir plugins to 'community'
    // so they can't escalate. Fallback to id-prefix detection (via
    // getPluginTrustInfo) when source is absent for defense in depth.
    const entry = pluginRegistry.get(body.pluginId);
    const trustInfo = getPluginTrustInfo(body.pluginId, entry?.source);
    const gate = c.get("rpcApprovalGate");
    const verdict = gate.evaluate({
      sessionId,
      pluginId: body.pluginId,
      action: `runtime:${body.runtimeId}`,
      payload: body.payload,
      trustLevel: trustInfo.source,
      description: target.description,
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
        {
          status: "error",
          error: `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
          code: "queue-full",
        },
        429,
      );
    }

    const worldDataPluginId = pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.WorldDataProvider,
    );
    const personaPluginId = pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.PersonaProvider,
    );
    const promptHistoryRewriterPluginId = pluginRegistry.findPluginByCapability(
      sessionId,
      FrameworkCapability.PromptHistoryRewriter,
    );
    const turnGetConfig =
      c.get("getConfigFn") ?? ((_pluginId: string, _runtimeId: string) => ({}));

    // Audit F7: player-authored plugin settings travel with the request
    // as a base64-encoded JSON header (`X-Plugin-User-Settings`) sourced
    // from the unified SettingsStore. The body map keys on pluginId so
    // executor merges per-runtime defaults with the matching player
    // bucket. Invalid JSON / bad base64 are silently ignored — settings
    // degrade gracefully to manifest defaults rather than failing the
    // turn. Never persisted server-side; request-scoped only.
    const userSettingsMap = decodePluginUserSettingsHeader(
      c.req.header("X-Plugin-User-Settings"),
    );

    await prepareToolsForSession?.(sessionId);
    // Just-in-time activation: community plugins skip eager tool import in
    // bootstrap. Now that the approval gate has cleared this RPC, ensure the
    // plugin's `tools.local` are registered before the runtime executes —
    // otherwise tool calls would resolve to `undefined` in the executor.
    // No-op for builtin/official plugins (already loaded at boot) and for
    // already-activated community plugins (idempotent).
    await c.get("activatePluginLocalTools")?.(body.pluginId);

    const turnId = crypto.randomUUID();

    const runtimeTurnRunner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus,
      sessionLock,
      sessionId,
      session,
      activeRuntimes,
      deps: {
        loadRuntime: loadRuntimeFn,
        llm: llmAdapter,
        ...(pluginGateway ? { gateway: pluginGateway } : {}),
        ...(pluginUtils ? { utils: pluginUtils } : {}),
        ...(getPluginSource ? { getPluginSource } : {}),
        getConfig: turnGetConfig,
        ...(mediaStore ? { mediaStore } : {}),
        toolExecutor,
        resolveModel,
        // Without eventBus the executor's emitSubEvent calls (turn.started,
        // runtime.started/completed, turn.completed, …) silently no-op,
        // leaving the trace timeline with only the two LLM lifecycle events
        // that flow through the parallel `emitter` channel. The /debug page
        // then can't tell the runtime ever finished. Wire it through so
        // manual-trigger turns produce the same trace surface as auto turns.
        compactor: compactorRunner,
        worldDataPluginId,
        personaPluginId,
        promptHistoryRewriterPluginId,
        ...(hookPipeline ? { hookPipeline } : {}),
      },
      ...(hookPipeline ? { hookPipeline } : {}),
    });

    const runManualTurn = () =>
      runtimeTurnRunner.runManualTurn({
        turnId,
        runtimeId: body.runtimeId!,
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(userSettingsMap ? { userSettings: userSettingsMap } : {}),
      });

    const jobRunner = createPluginRpcJobRunner({
      store,
      sessionId,
      ...(userSettingsMap ? { userSettings: userSettingsMap } : {}),
      runManualTurn,
      runDeferredFollowerTurn: (args) =>
        runtimeTurnRunner.runDeferredFollowerTurn(args),
      hasActiveRuntime: (runtimeId) =>
        activeRuntimes.some((rt) => rt.name === runtimeId),
    });

    const mode: "sync" | "background" = target.execution ?? "sync";

    // ── Background mode ────────────────────────────────────────────
    //
    // Write `_jobs/{jobId}` as `pending` immediately so the frontend can
    // render a loading state, return 202 + {jobId}, and continue the
    // work in `setImmediate`. Dependencies (store, eventBus, executor,
    // locks) are all captured from the bootstrap closure via `c.get(...)`
    // above — they are long-lived and safe to reference after the
    // response has been flushed.
    //
    // The `_jobs` namespace is reserved by the framework. Any write to
    // `setPluginData` flows through the store-proxy, which emits
    // `plugin-data.changed` on the event bus; SSE subscribers pick it
    // up and update the UI. No bespoke streaming protocol.
    if (mode === "background") {
      let job;
      try {
        job = await jobRunner.enqueueBackgroundRuntime({
          pluginId: body.pluginId,
          runtimeId: body.runtimeId,
          turnId,
          payload: body.payload,
        });
      } catch (err) {
        return c.json(
          {
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : "failed to enqueue background job",
            code: "background-enqueue-failed",
          },
          500,
        );
      }

      return c.json(
        {
          status: "accepted",
          jobId: job.jobId,
          pending: true,
          turnId,
          runtimeId: job.runtimeId,
        },
        202,
      );
    }

    // ── Sync mode ──────────────────────────────────────────────────
    //
    // Audit F1: the sync turn may surface `deferredFollowers` — event-chain
    // followers with `execution: 'background'` that were skipped so the
    // user gets an immediate response. Persist one `_jobs/<jobId>` pending
    // row per follower BEFORE responding so the frontend can render a
    // loading state, then fire each follower with setImmediate so the
    // response flushes without waiting for image generation etc.
    //
    // UX: some sync entry runtimes are only prompt-builders for a background
    // follower (e.g. image prompt-generator → image-generator). When the
    // client declares `expectsBackgroundFollower`, write a `_jobs` placeholder
    // immediately and run the sync prompt-builder off-request as well. The UI
    // can then show "generating prompt" at once instead of waiting 20–40s for
    // the prompt LLM call before any job row exists.
    if (body.expectsBackgroundFollower === true) {
      let job;
      try {
        job = await jobRunner.enqueueExpectedFollowerRuntime({
          pluginId: body.pluginId,
          runtimeId: body.runtimeId,
          turnId,
        });
      } catch (err) {
        return c.json(
          {
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : "failed to enqueue prompt job",
            code: "prompt-job-enqueue-failed",
          },
          500,
        );
      }

      return c.json(
        {
          status: "accepted",
          jobId: job.jobId,
          pending: true,
          turnId,
          runtimeId: job.runtimeId,
          phase: job.phase,
        },
        202,
      );
    }

    try {
      const summary = await runManualTurn();
      const deferredJobs =
        summary.deferredFollowers.length > 0
          ? await jobRunner.scheduleDeferredFollowers(summary.deferredFollowers)
          : [];
      return c.json({
        status: "ok",
        turnId: summary.turnId,
        runtimeResults: summary.runtimeResults,
        durationMs: summary.durationMs,
        ...(summary.abortReason ? { abortReason: summary.abortReason } : {}),
        ...(deferredJobs.length > 0 ? { deferredJobs } : {}),
      });
    } catch (err) {
      return c.json(
        {
          status: "error",
          error:
            err instanceof Error ? err.message : "runtime execution failed",
          code: "runtime-execution-failed",
        },
        500,
      );
    }
  }

  // PR-7: approval gate. Look up the resolved entry first so we know its
  // trust level, then ask the gate whether the call can proceed. Builtin
  // and official trust auto-allow; community trust either re-uses a cached
  // session approval or returns approval-required for the dialog flow.
  //
  // We deliberately resolve the entry BEFORE invoking the gate so that
  // unknown actions surface as a 404 instead of getting parked in the
  // approval queue forever.
  //
  // LOW-3: framework default actions are namespace-less but still need a
  // canonical sentinel for the request shape. The dispatcher requires
  // `pluginId === "framework"` for framework defaults. Plugin-declared
  // actions still use the real plugin ID.
  const FRAMEWORK_PLUGIN_SENTINEL = "framework";
  const action = body.action!;
  const pluginId = body.pluginId;
  const registry = c.get("rpcRegistry");
  const gate = c.get("rpcApprovalGate");
  let entryTrust: "builtin" | "official" | "community" = "community";
  let entryDescription: string | undefined;
  const pluginEntry =
    pluginId === FRAMEWORK_PLUGIN_SENTINEL
      ? undefined
      : registry.getPluginAction(pluginId, action);
  if (pluginEntry) {
    entryTrust = pluginEntry.trustLevel;
    entryDescription = pluginEntry.description;
  } else if (pluginId === FRAMEWORK_PLUGIN_SENTINEL) {
    const fwEntry = registry.getFrameworkDefault(action);
    if (fwEntry) {
      entryTrust = fwEntry.trustLevel; // always 'builtin'
      entryDescription = fwEntry.description;
    } else {
      return c.json(
        {
          status: "error",
          error: `unknown framework action "${action}"`,
          code: "unknown-action",
        },
        404,
      );
    }
  } else {
    return c.json(
      {
        status: "error",
        error: `unknown action "${action}" for plugin "${pluginId}"`,
        code: "unknown-action",
      },
      404,
    );
  }

  const verdict = gate.evaluate({
    sessionId,
    pluginId,
    action,
    payload: body.payload,
    trustLevel: entryTrust,
    description: entryDescription,
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
    // MEDIUM-1: pending queue is full. Map to 429 so clients back off.
    return c.json(
      {
        status: "error",
        error: `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
        code: "queue-full",
      },
      429,
    );
  }

  // Action-level dispatch.
  try {
    const rpcStore =
      entryTrust === "builtin" || entryTrust === "official"
        ? store
        : createRpcHandlerStoreView(store, {
            sessionId,
            pluginId,
          });
    const dispatch = await executor.dispatch(
      {
        pluginId,
        action,
        payload: body.payload,
      },
      { sessionId, store: rpcStore },
    );
    return c.json({ status: "ok", result: dispatch.result });
  } catch (err) {
    if (err instanceof RpcValidationError) {
      return c.json({ status: "error", error: err.message }, 400);
    }
    if (err instanceof RpcDispatchError) {
      const code = err.code === "unknown-action" ? 404 : 500;
      return c.json(
        { status: "error", error: err.message, code: err.code },
        code,
      );
    }
    return c.json(
      {
        status: "error",
        error:
          err instanceof Error ? err.message : "plugin-rpc dispatch failed",
      },
      500,
    );
  }
});
