import { resolveMediaImageFlow } from "./media-image-flow.js";
import {
  announceQueuedRuntimeJobs,
  withSettledSessionLock,
} from "./plugin-rpc/settled-request.js";
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
 *        - `'background'` — queues a durable runtime job and returns its
 *          jobId; status streams as `job-status.updated` and `_runtime_jobs`
 *          plugin-data changes.
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
import { snapshotUserSettings } from "@covel/runtime";
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
import {
  enqueueActivatedRuntimeJob,
  enqueueEventFollowers,
  type QueuedActivatedRuntimeJob,
} from "./plugin-rpc/runtime-job-enqueue.js";
import { RuntimeJobQueueFullError } from "./plugin-rpc/jobs.js";
import {
  createPluginRpcRuntimeTurnRunner,
  SessionApprovalScopeChangedError,
  SessionNotActiveError,
} from "./plugin-rpc/runtime-turn.js";
import { commitFailureMessage } from "./plugin-rpc/runtime-response.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  checkHostedOperator,
  checkSessionOwner,
  sessionApprovalScope,
} from "./session/session-guard.js";
import {
  parseSessionCommandInvocation,
  resolveSessionCommand,
} from "./session/commands.js";
import { buildTurnExecutorDeps } from "./turn-execution-deps.js";
import { topLevelTurnResults } from "./actions/turn-history.js";
import {
  concealResultSummaries,
  registeredConcealedRuntimeIds,
} from "./concealed-runtimes.js";
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
  //   - `'background'` → queue a durable runtime job, return 202 + {jobId};
  //     the runtime job worker executes and commits it (see below).
  if (body.kind === "runtime") {
    const pluginRegistry = c.get("pluginRegistry");
    const eventBus = c.get("eventBus");
    const hookPipeline = c.get("hookPipeline");
    const sessionLock = c.get("sessionLock");
    const prepareToolsForSession = c.get("prepareToolsForSession");

    // Reconcile the process-local registry from the persisted session
    // snapshot under the session lock. Besides restart recovery, this removes
    // stale activations after a plugin is disabled through another request or
    // server instance. The lock matters: `syncSessionActivations` writes
    // shared in-memory state, and syncing from the lock-free snapshot read
    // above could resurrect a plugin that a concurrent enable/disable writer
    // has just persisted and deactivated (lost update). Under the lock the
    // fresh read is linearised against those writers, keeping this a pure
    // read-repair. A session deleted in the meantime reconciles to the empty
    // set, so the runtime lookup below fails closed with `runtime_not_active`.
    const activeRuntimes = await withSettledSessionLock(
      c,
      sessionId,
      async () => {
        const live = await store.getSession(sessionId);
        const livePlugins = live?.activePlugins as
          readonly string[] | undefined;
        pluginRegistry.syncSessionActivations(sessionId, livePlugins ?? []);
        return pluginRegistry.getActiveRuntimes(sessionId);
      },
    );
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
      ? await store.getWorld(session.worldId)
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
      const rows = topLevelTurnResults(await store.listTurnResults(sessionId));
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
      memorySystem: c.get("memorySystem"),
      resolveImageFlowRuntimeIds: async () =>
        (
          await resolveMediaImageFlow(
            store,
            c.get("pluginExtensions"),
            sessionId,
          )
        )?.assetRuntimeIds,
      withSettledLock: (fn, waitBudget) =>
        withSettledSessionLock(c, sessionId, fn, waitBudget),
      withSnapshot: (fn, beforeCapture) =>
        c.get("withPluginSnapshot")?.(sessionId, fn, beforeCapture) ??
        sessionLock.withLock(sessionId, async () => beforeCapture?.()).then(fn),
      pluginRegistry,
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
      deps: buildTurnExecutorDeps(c),
      ...(hookPipeline ? { hookPipeline } : {}),
    });

    const mode: "sync" | "background" = target.execution ?? "sync";
    const queueError = (err: unknown) => {
      if (err instanceof SessionNotActiveError)
        return c.json(
          errorBody(err.message, { code: "session_not_active" }),
          409,
        );
      if (err instanceof SessionApprovalScopeChangedError)
        return c.json(
          errorBody(err.message, { code: "approval_scope_changed" }),
          409,
        );
      if (err instanceof RuntimeJobQueueFullError)
        return c.json(
          errorBody(err.message, { code: "background_queue_full" }),
          429,
        );
      return c.json(
        errorBody(
          err instanceof Error ? err.message : "failed to enqueue runtime job",
          { code: "background_enqueue_failed" },
        ),
        500,
      );
    };

    // ── Background mode / expected follower ────────────────────────
    //
    // `execution: background` runtimes, and sync prompt-builders whose client
    // declares `expectsBackgroundFollower`, run on the durable runtime job
    // worker: the job is queued here, returned as 202 + {jobId}, and its
    // status streams as `job-status.updated` plus `_runtime_jobs` plugin-data
    // changes. Queuing the prompt-builder lets the UI show progress at once
    // instead of waiting for the prompt LLM call.
    if (mode === "background" || body.expectsBackgroundFollower === true) {
      const expectFollower =
        mode !== "background" && body.expectsBackgroundFollower === true;
      let queued;
      try {
        queued = await sessionLock.withLock(sessionId, async () => {
          const live = await store.getSession(sessionId);
          if (!live) throw new SessionNotActiveError("deleted");
          if (live.status !== "active")
            throw new SessionNotActiveError(live.status);
          if (sessionApprovalScope(live, body.pluginId) !== approvalScope)
            throw new SessionApprovalScopeChangedError();
          return store.withTransaction((tx) =>
            enqueueActivatedRuntimeJob(tx, {
              sessionId,
              session: live,
              pluginId: body.pluginId,
              runtimeId: body.runtimeId!,
              activation: "manual",
              sourceTurnId: body.retryFromTurnId ?? turnId,
              turnId,
              locale: live.locale,
              ...(userSettingsMap
                ? { userSettings: snapshotUserSettings(userSettingsMap) }
                : {}),
              ...(body.payload !== undefined ? { input: body.payload } : {}),
              ...(body.retryFromTurnId
                ? { retryFromTurnId: body.retryFromTurnId }
                : {}),
              ...(expectFollower ? { expectFollower: true } : {}),
            }),
          );
        });
      } catch (err) {
        return queueError(err);
      }
      announceQueuedRuntimeJobs(c, [queued]);
      return c.json(
        {
          status: "accepted",
          jobId: queued.job.jobId,
          pending: true,
          turnId,
          runtimeId: queued.job.runtimeId,
          ...(expectFollower ? { phase: "prompt" } : {}),
        },
        202,
      );
    }

    // ── Sync mode ──────────────────────────────────────────────────
    //
    // The sync turn may surface `deferredFollowers` — event-chain followers
    // with `execution: 'background'` that were skipped so the user gets an
    // immediate response. They are queued as durable event jobs inside the
    // same commit transaction, so a rolled-back turn queues nothing.
    const followerJobs: QueuedActivatedRuntimeJob[] = [];
    try {
      const summary = await runtimeTurnRunner.runManualTurn({
        turnId,
        runtimeId: body.runtimeId,
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(userSettingsMap ? { userSettings: userSettingsMap } : {}),
        ...(retrySeedResults
          ? { retrySeedResults, sourceTurnId: body.retryFromTurnId }
          : {}),
        completeInTx: async (tx, result) => {
          followerJobs.push(
            ...(await enqueueEventFollowers(tx, {
              sessionId,
              activeRuntimes,
              followers: result.deferredFollowers ?? [],
              sourceTurnId: result.turnId,
              sourceRuntimeId: body.runtimeId,
              locale: session.locale,
              ...(userSettingsMap
                ? { userSettings: snapshotUserSettings(userSettingsMap) }
                : {}),
            })),
          );
        },
      });
      // The runtime can report success while its proposals fail to land. A
      // turn whose writes never committed is not a successful turn: report it
      // as an error; its follower jobs rolled back with it.
      if (!summary.commit.committed) {
        if (summary.commit.dimensionConflict)
          return c.json(
            errorBody("dimension-version-conflict", {
              code: "dimension-version-conflict",
              details: {
                currentVersions:
                  summary.commit.dimensionConflict.currentVersions,
              },
            }),
            409,
          );
        return c.json(
          errorBody(commitFailureMessage(summary.commit), {
            code: "turn_commit_failed",
            details: {
              turnId: summary.turnId,
              runtimeResults: concealResultSummaries(
                summary.runtimeResults,
                registeredConcealedRuntimeIds(pluginRegistry),
              ),
            },
          }),
          500,
        );
      }
      announceQueuedRuntimeJobs(c, followerJobs);
      const deferredJobs = followerJobs.map(({ job }) => ({
        jobId: job.jobId,
        runtimeId: job.runtimeId,
      }));
      return c.json({
        status: "ok",
        turnId: summary.turnId,
        runtimeResults: concealResultSummaries(
          summary.runtimeResults,
          registeredConcealedRuntimeIds(pluginRegistry),
        ),
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
      if (err instanceof RuntimeJobQueueFullError) {
        return c.json(
          errorBody(err.message, { code: "background_queue_full" }),
          429,
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
