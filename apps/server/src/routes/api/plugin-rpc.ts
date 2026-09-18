/**
 * Plugin RPC route.
 *
 * Single channel for all structured plugin commands:
 *
 *   POST /api/sessions/:id/plugin-rpc
 *   {
 *     "kind": "action",
 *     "pluginId": "codex",
 *     "action": "regenerate",
 *     "payload": { ... }
 *   }
 *
 * Three dispatch kinds:
 *
 *   1. Action-level (`kind: "action"`) — delegates to an inline handler registered
 *      by the plugin entry or a framework default. Returns a
 *      single JSON response.
 *
 *   2. Runtime-level (`kind: "runtime"`) — invokes `executeTurn` with
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
 *   3. Command-level (`kind: "command"`) — resolves `commandId` against the
 *      active session command directory, validates text or structured args,
 *      then dispatches the server-owned plugin action.
 *
 * Resolution order for action dispatch:
 *   1. Plugin entry-registered action
 *   2. Framework default (registry.getFrameworkDefault)
 */

import { Hono } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import {
  type RpcCommandInvocation,
  type RuntimeResult,
  type SessionSlashCommand,
} from "@covel/shared";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { validatePluginRpcBody } from "./plugin-rpc/body.js";
import {
  decodePluginUserSettingsHeader,
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "./plugin-user-settings.js";
import { getCachedWorld } from "../../world-cache.js";
import { createPluginRpcJobRunner } from "./plugin-rpc/background-jobs.js";
import {
  createPluginRpcRuntimeTurnRunner,
  SessionApprovalScopeChangedError,
  SessionNotActiveError,
} from "./plugin-rpc/runtime-turn.js";
import { commitFailureMessage } from "./plugin-rpc/runtime-response.js";
import { resolveTurnCapabilityPluginIds } from "./turn-capabilities.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  checkHostedOperator,
  checkSessionOwner,
  sessionIncarnationIdentity,
  sessionApprovalScope,
} from "./session/session-guard.js";
import {
  parseSessionCommandInvocation,
  resolveSessionCommand,
} from "./session/commands.js";
import { buildTurnExecutorDeps } from "./turn-execution-deps.js";
import { errorBody, readJsonBody } from "../../api-error.js";
import { dispatchPluginAction } from "./plugin-rpc/action-dispatch.js";

export const pluginRpcRoutes = new Hono();

function toApiErrorCode(code: string): string {
  return code.replaceAll("-", "_");
}

// Runtime-mode dispatch runs the full turn pipeline (LLM call) — same cost
// class as POST /api/actions, so same budget.
pluginRpcRoutes.post("/:id/plugin-rpc", rateLimiter({ max: 30 }), async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const decodedUserSettings = decodePluginUserSettingsHeader(
    c.req.header("X-Plugin-User-Settings"),
  );
  if (!decodedUserSettings.ok) {
    return c.json(
      errorBody(decodedUserSettings.error, {
        code: toApiErrorCode(decodedUserSettings.code),
      }),
      decodedUserSettings.status,
    );
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json(
      errorBody(`Session "${sessionId}" not found`, {
        code: "session_not_found",
      }),
      404,
    );
  }
  // Owner guard (hosted tiers): plugin-rpc can trigger manual runtimes
  // (full turn pipeline) and mutate plugin data.
  const ownerDenied = checkSessionOwner(c, session);
  if (ownerDenied) return ownerDenied;
  const expectedIncarnation = sessionIncarnationIdentity(session);
  if (session.status !== "active") {
    return c.json(
      errorBody(`session is ${session.status}; plugin RPC execution refused`, {
        code: "session_not_active",
      }),
      409,
    );
  }

  const parsedJson = await readJsonBody(c);
  if (parsedJson instanceof Response) return parsedJson;
  const rawBody = parsedJson.body;

  const bodyResult = validatePluginRpcBody(rawBody);
  if (!bodyResult.ok) {
    return c.json(errorBody(bodyResult.error), bodyResult.status);
  }
  const body = bodyResult.body;

  // Command mode resolves the client-supplied stable id against the current
  // session directory. The server owns plugin/action/context selection and
  // validates composer text or named UI args again; the client cannot expand a
  // command's context scopes or dispatch it into another plugin.
  let resolvedCommand: SessionSlashCommand | undefined;
  let commandInvocation: RpcCommandInvocation | undefined;
  const commandInvocationId =
    body.kind === "command" ? crypto.randomUUID() : undefined;
  if (body.kind === "command") {
    resolvedCommand = resolveSessionCommand(
      body.commandId,
      session.activePlugins ?? [],
      c.get("pluginRegistry"),
    );
    if (!resolvedCommand) {
      return c.json(
        errorBody(`command "${body.commandId}" is not active in this session`, {
          code: "command_not_active",
        }),
        404,
      );
    }
    const parsed = parseSessionCommandInvocation(
      resolvedCommand,
      body,
      commandInvocationId!,
    );
    if (!parsed.ok) {
      return c.json(
        errorBody(parsed.message, { code: toApiErrorCode(parsed.code) }),
        400,
      );
    }
    commandInvocation = parsed.invocation;
  }

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
  if (body.kind === "runtime") {
    const pluginRegistry = c.get("pluginRegistry");
    const eventBus = c.get("eventBus");
    const hookPipeline = c.get("hookPipeline");
    const sessionLock = c.get("sessionLock");
    const prepareToolsForSession = c.get("prepareToolsForSession");

    // Reconcile the process-local registry from the persisted session
    // snapshot. Besides restart recovery, this removes stale activations
    // after a plugin is disabled through another request or server instance.
    const sessionPlugins = session.activePlugins as
      readonly string[] | undefined;
    pluginRegistry.syncSessionActivations(sessionId, sessionPlugins ?? []);

    const activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
    const target = activeRuntimes.find((rt) => rt.name === body.runtimeId);
    if (!target) {
      return c.json(
        errorBody(
          `runtime "${body.runtimeId}" not active in session ${sessionId}`,
          { code: "runtime_not_active" },
        ),
        404,
      );
    }
    if (target.pluginId !== body.pluginId) {
      return c.json(
        errorBody(
          `runtime "${body.runtimeId}" belongs to plugin "${target.pluginId}", not "${body.pluginId}"`,
          { code: "plugin_mismatch" },
        ),
        400,
      );
    }

    // Approval gate — trust comes from plugin discovery source, NOT from
    // the manifest's `pluginType` field. `pluginType` is author-supplied and
    // could be forged by a third-party plugin claiming `core-plugin` to
    // auto-bypass approval. `entry.source` is set by bootstrap from the
    // discovery pipeline, which clamps non-first-dir plugins to 'community'
    // so they can't escalate. A missing source remains community-trusted.
    const entry = pluginRegistry.get(body.pluginId);
    const trustInfo = getPluginTrustInfo(body.pluginId, entry?.source);
    if (trustInfo.source === "community") {
      const operatorDenied = checkHostedOperator(c);
      if (operatorDenied) return operatorDenied;
    }
    const gate = c.get("rpcApprovalGate");
    const approvalScope = sessionApprovalScope(session, body.pluginId);
    // Two-phase approval: executing a community runtime imports the
    // plugin's server code AND runs the specific runtime, and the runtime
    // loader now requires BOTH exact grants. Ask for the server-code grant
    // first when it is missing (same pattern as entry-action dispatch), then
    // the `runtime:<name>` grant; the renderer's retry walks the phases.
    const needsServerCodeGrant =
      trustInfo.source === "community" &&
      !gate.hasGrant(
        sessionId,
        body.pluginId,
        COMMUNITY_SERVER_CODE_ACTION,
        approvalScope,
      );
    const verdict = gate.evaluate({
      sessionId,
      sessionScope: approvalScope,
      pluginId: body.pluginId,
      action: needsServerCodeGrant
        ? COMMUNITY_SERVER_CODE_ACTION
        : `runtime:${body.runtimeId}`,
      payload: body.payload,
      trustLevel: trustInfo.source,
      description: needsServerCodeGrant
        ? `Load server-side code for community plugin ${body.pluginId}`
        : target.description,
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
          `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
          { code: "queue_full" },
        ),
        429,
      );
    }

    const capabilityPluginIds = resolveTurnCapabilityPluginIds(
      pluginRegistry,
      sessionId,
    );
    // Player-authored plugin settings travel with the request
    // as a base64-encoded JSON header (`X-Plugin-User-Settings`) sourced
    // from the unified SettingsStore. The body map keys on pluginId so
    // executor merges per-runtime defaults with the matching player
    // bucket. Invalid JSON / bad base64 are silently ignored — settings
    // degrade gracefully to manifest defaults rather than failing the
    // turn. Never persisted server-side; request-scoped only.
    // Merge the world's authored defaults (WorldRecord.metadata.pluginSettings)
    // under the player's header overrides — same resolution chain as the main
    // turn route (player override → world default → manifest default).
    const world = session.worldId
      ? await getCachedWorld(store, session.worldId)
      : null;
    const userSettingsMap = mergePluginUserSettings(
      readWorldPluginSettings(world?.metadata),
      decodedUserSettings.settings,
    );

    await prepareToolsForSession?.(sessionId);
    // Just-in-time activation: community plugins skip eager entry execution in
    // bootstrap. Now that the approval gate has cleared this RPC, run the
    // plugin entry before the runtime executes so its tools and other server
    // registrations are available.
    // No-op for builtin plugins (already loaded at boot) and for
    // already-activated community plugins (idempotent).
    await c.get("activatePluginServerCode")?.(body.pluginId, sessionId);

    // Retry mode: load the original turn's persisted artifact so the retried
    // runtime resolves its inject/needs against the recorded outputs
    // (narrative etc.) instead of empty manual-trigger context.
    let retrySeedResults: readonly RuntimeResult[] | undefined;
    if (body.retryFromTurnId) {
      // ponytail: full artifact scan (listTurnResults sorts ascending, so a
      // head-limit would miss recent turns) — add a keyed getter to the store
      // contract if long sessions make this show up in traces.
      const rows = await store.listTurnResults(sessionId);
      const row = rows.find((r) => r.turnId === body.retryFromTurnId);
      if (!row) {
        return c.json(
          errorBody(
            `turn "${body.retryFromTurnId}" has no persisted results in session ${sessionId}`,
            { code: "retry_turn_not_found" },
          ),
          404,
        );
      }
      retrySeedResults = (
        Array.isArray(row.runtimeResults) ? row.runtimeResults : []
      ) as RuntimeResult[];
    }

    const turnId = crypto.randomUUID();

    const runtimeTurnRunner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus,
      sessionLock,
      sessionId,
      session,
      activeRuntimes,
      approvalScopes: new Map(
        activeRuntimes.map((runtime) => [
          runtime.pluginId,
          sessionApprovalScope(session, runtime.pluginId),
        ]),
      ),
      deps: buildTurnExecutorDeps(c, capabilityPluginIds),
      ...(hookPipeline ? { hookPipeline } : {}),
    });

    const runManualTurn = (executionSignal?: AbortSignal) =>
      runtimeTurnRunner.runManualTurn({
        executionSignal,
        turnId,
        runtimeId: body.runtimeId!,
        // Background mode returns 202 and detaches from this request, and the
        // runtimes that use it are media generations that run for minutes —
        // they must not hold the session lock while doing so. Sync mode is
        // awaited by the caller and stays fully serialised.
        ...((target.execution ?? "sync") === "background"
          ? { detached: true }
          : {}),
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(userSettingsMap ? { userSettings: userSettingsMap } : {}),
        ...(retrySeedResults ? { retrySeedResults } : {}),
      });

    const jobRunner = createPluginRpcJobRunner({
      queue: c.get("pluginBackgroundQueue"),
      store,
      sessionId,
      sessionLock,
      approvalScopes: new Map(
        activeRuntimes.map((runtime) => [
          runtime.pluginId,
          sessionApprovalScope(session, runtime.pluginId),
        ]),
      ),
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
        if (err instanceof SessionNotActiveError) {
          return c.json(
            errorBody(err.message, { code: "session_not_active" }),
            409,
          );
        }
        if (err instanceof SessionApprovalScopeChangedError) {
          return c.json(
            errorBody(err.message, { code: "approval_scope_changed" }),
            409,
          );
        }
        return c.json(
          errorBody(
            err instanceof Error
              ? err.message
              : "failed to enqueue background job",
            { code: "background_enqueue_failed" },
          ),
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
    // The sync turn may surface `deferredFollowers` — event-chain
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
        if (err instanceof SessionNotActiveError) {
          return c.json(
            errorBody(err.message, { code: "session_not_active" }),
            409,
          );
        }
        if (err instanceof SessionApprovalScopeChangedError) {
          return c.json(
            errorBody(err.message, { code: "approval_scope_changed" }),
            409,
          );
        }
        return c.json(
          errorBody(
            err instanceof Error ? err.message : "failed to enqueue prompt job",
            { code: "prompt_job_enqueue_failed" },
          ),
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
      // The runtime can report success while its proposals fail to land. A
      // turn whose writes never committed is not a successful turn: report it
      // as an error and do not chain followers onto rolled-back state.
      if (!summary.commit.committed) {
        return c.json(
          errorBody(commitFailureMessage(summary.commit), {
            code: "turn_commit_failed",
            details: {
              turnId: summary.turnId,
              runtimeResults: summary.runtimeResults,
            },
          }),
          500,
        );
      }
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
      if (err instanceof SessionNotActiveError) {
        return c.json(
          errorBody(err.message, { code: "session_not_active" }),
          409,
        );
      }
      if (err instanceof SessionApprovalScopeChangedError) {
        return c.json(
          errorBody(err.message, { code: "approval_scope_changed" }),
          409,
        );
      }
      return c.json(
        errorBody(
          err instanceof Error ? err.message : "runtime execution failed",
          { code: "runtime_execution_failed" },
        ),
        500,
      );
    }
  }

  return dispatchPluginAction(
    c,
    session,
    body,
    resolvedCommand,
    commandInvocation,
    commandInvocationId,
  );
});
