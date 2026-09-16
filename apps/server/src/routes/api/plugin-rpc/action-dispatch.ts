import type { Context } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import {
  createRpcHandlerStoreView,
  createTrustedHandlerStore,
  RpcDispatchError,
  RpcValidationError,
} from "@covel/runtime";
import type {
  PluginRpcRequest,
  RpcCommandInvocation,
  SessionSlashCommand,
} from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import {
  checkHostedOperator,
  sessionIncarnationIdentity,
  sessionApprovalScope,
  SESSION_DELETION_PENDING_KEY,
} from "../session/session-guard.js";
import {
  buildCommandEnvironment,
  parseSessionCommandInvocation,
  resolveSessionCommand,
} from "../session/commands.js";
import { runTracedCommand } from "./command-trace.js";
import { preflightFormApprovals } from "./form-approvals.js";
import { errorBody } from "../../../api-error.js";

/** Action dispatch and form authorization share the same session commit lock. */
export async function dispatchPluginAction(
  c: Context,
  session: SessionRecord,
  body: Exclude<PluginRpcRequest, { kind: "runtime" }>,
  resolvedCommand?: SessionSlashCommand,
  commandInvocation?: RpcCommandInvocation,
  commandInvocationId?: string,
): Promise<Response> {
  const store = c.get("store");
  const executor = c.get("rpcExecutor");
  const sessionId = session.id;
  const expectedIncarnation = sessionIncarnationIdentity(session);
  // Approval gate. Look up the resolved entry first so we know its
  // trust level, then ask the gate whether the call can proceed.
  // Builtin trust auto-allows; community trust either re-uses a cached
  // session approval or returns approval-required for the dialog flow.
  //
  // We deliberately resolve the entry BEFORE invoking the gate so that
  // unknown actions surface as a 404 instead of getting parked in the
  // approval queue forever.
  //
  // Exception (H2): a community plugin that migrated its rpc actions to a
  // deferred `entry` module has NO registered declaration yet — community
  // entry code must not run before the approval gate clears. So on a miss
  // for a plugin with a pending entry we resolve its discovery trust before
  // activation. This also permits retrying builtin entries that failed at boot.
  //
  // Framework default actions are namespace-less but still need a
  // canonical sentinel for the request shape. The dispatcher requires
  // `pluginId === "framework"` for framework defaults. Plugin-declared
  // actions still use the real plugin ID.
  const FRAMEWORK_PLUGIN_SENTINEL = "framework";
  const action =
    body.kind === "command" ? resolvedCommand!.action : body.action;
  const pluginId =
    body.kind === "command" ? resolvedCommand!.pluginId : body.pluginId;
  const actionPayload =
    body.kind === "command" ? commandInvocation : body.payload;
  const registry = c.get("rpcRegistry");
  const gate = c.get("rpcApprovalGate");
  const approvalScope = sessionApprovalScope(session, pluginId);
  const hasPendingPluginEntry = c.get("hasPendingPluginEntry");
  let entryTrust: "builtin" | "community" = "community";
  let entryDescription: string | undefined;
  // When true, the action belongs to a not-yet-activated entry —
  // activate the entry after the gate allows, then dispatch (which re-resolves).
  let pendingEntryActivation = false;
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
        errorBody(`unknown framework action "${action}"`, {
          code: "unknown_action",
        }),
        404,
      );
    }
  } else if (hasPendingPluginEntry?.(pluginId)) {
    // Pending includes failed builtin activations. Unknown sources remain
    // community-trusted, just as on the runtime-level RPC path above.
    const source = c.get("pluginRegistry").get(pluginId)?.source;
    entryTrust = getPluginTrustInfo(pluginId, source).source;
    pendingEntryActivation = true;
  } else {
    return c.json(
      errorBody(`unknown action "${action}" for plugin "${pluginId}"`, {
        code: "unknown_action",
      }),
      404,
    );
  }
  // Community modules execute in the server process and register global
  // capabilities. Hosted deployments therefore require the operator
  // credential in addition to the session owner token.
  if (entryTrust === "community") {
    const operatorDenied = checkHostedOperator(c);
    if (operatorDenied) return operatorDenied;
  }

  // Two-phase approval for every community server module. Ask for the
  // server-code grant first when it is missing, then the precise action grant.
  const needsServerCodeGrant =
    entryTrust === "community" &&
    !gate.hasGrant(
      sessionId,
      pluginId,
      COMMUNITY_SERVER_CODE_ACTION,
      approvalScope,
    );
  // A deferred entry always takes the server-code phase first: we cannot know
  // whether `action` even exists until the (untrusted) entry has run.
  const approvalAction =
    needsServerCodeGrant || pendingEntryActivation
      ? COMMUNITY_SERVER_CODE_ACTION
      : action;
  const verdict = gate.evaluate({
    sessionId,
    sessionScope: approvalScope,
    pluginId,
    action: approvalAction,
    payload: actionPayload,
    trustLevel: entryTrust,
    description:
      approvalAction === COMMUNITY_SERVER_CODE_ACTION
        ? `Load server-side code for community plugin ${pluginId}`
        : entryDescription,
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
    // Pending queue is full. Map to 429 so clients back off.
    return c.json(
      errorBody(
        `approval queue is full (limit ${verdict.limit}); try again after resolving pending approvals`,
        { code: "queue_full" },
      ),
      429,
    );
  }

  // Deferred community entry cleared the gate — activate its server code so
  // the entry-registered handler exists before dispatch re-resolves it.
  // No-op for already-activated plugins (idempotent). If the entry still
  // doesn't register `action`, dispatch throws unknown-action → 404 below.
  if (pendingEntryActivation || needsServerCodeGrant) {
    if (pendingEntryActivation) {
      await c.get("activatePluginServerCode")?.(pluginId, sessionId);
      const activatedEntry = registry.getPluginAction(pluginId, action);
      if (!activatedEntry) {
        return c.json(
          errorBody(`unknown action "${action}" for plugin "${pluginId}"`, {
            code: "unknown_action",
          }),
          404,
        );
      }
      entryTrust = activatedEntry.trustLevel;
      entryDescription = activatedEntry.description;
    }
    const actionVerdict = gate.evaluate({
      sessionId,
      sessionScope: approvalScope,
      pluginId,
      action,
      payload: actionPayload,
      trustLevel: entryTrust,
      description: entryDescription,
    });
    if (actionVerdict.status === "pending") {
      return c.json(
        {
          status: "approval-required",
          approvalId: actionVerdict.approvalId,
          pending: actionVerdict.pending,
        },
        202,
      );
    }
    if (actionVerdict.status === "rejected") {
      return c.json(
        errorBody(
          `approval queue is full (limit ${actionVerdict.limit}); try again after resolving pending approvals`,
          { code: "queue_full" },
        ),
        429,
      );
    }
  }

  // Action-level dispatch.
  try {
    // Trusted handlers keep the full store surface, minus writes into
    // framework-reserved `_` namespaces (the job runner and other framework
    // writers use the raw store, not this handle).
    const rpcStore =
      entryTrust === "builtin"
        ? createTrustedHandlerStore(store)
        : createRpcHandlerStoreView(store, {
            sessionId,
            pluginId,
          });
    // Action handlers can perform read-validate-write sequences (the framework
    // submit-form default is one). Serialize them with turns and sibling RPCs
    // so the interaction check and idempotent player-input write are atomic at
    // the session boundary, including across PG-backed server processes.
    const dispatchAction = async () => {
      // Approval was evaluated before taking the session lock so a dialog can
      // return promptly. Re-read the incarnation under the lock before running
      // community code: disable/revoke/delete+recreate may have rotated it
      // while this request waited. Do not evaluate twice on the normal path —
      // that would consume a one-time grant twice.
      const liveSession = await store.getSession(sessionId);
      if (!liveSession) {
        return c.json(
          errorBody(`Session "${sessionId}" not found`, {
            code: "session_not_found",
          }),
          404,
        );
      }
      if (sessionIncarnationIdentity(liveSession) !== expectedIncarnation) {
        return c.json(
          errorBody("session was replaced while the request was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (
        liveSession.status !== "active" ||
        liveSession.metadata?.[SESSION_DELETION_PENDING_KEY]
      ) {
        return c.json(
          errorBody(
            `session is ${liveSession.status}; plugin RPC execution refused`,
            {
              code: liveSession.metadata?.[SESSION_DELETION_PENDING_KEY]
                ? "session_deleting"
                : "session_not_active",
            },
          ),
          409,
        );
      }
      if (
        entryTrust === "community" &&
        sessionApprovalScope(liveSession, pluginId) !== approvalScope
      ) {
        return c.json(
          errorBody("approval scope changed while the request was waiting", {
            code: "approval_scope_changed",
          }),
          409,
        );
      }
      const liveActivePlugins = liveSession.activePlugins ?? [];
      if (pluginId === FRAMEWORK_PLUGIN_SENTINEL && action === "submit-form") {
        const approval = await preflightFormApprovals(
          c,
          liveSession,
          actionPayload,
        );
        if (approval) return approval;
      }
      let liveCommand = resolvedCommand;
      let liveInvocation = commandInvocation;
      let activeRuntimes: readonly import("@covel/shared").RuntimeManifest[] =
        [];
      if (body.kind === "command") {
        liveCommand = resolveSessionCommand(
          body.commandId,
          liveActivePlugins,
          c.get("pluginRegistry"),
        );
        if (
          !liveCommand ||
          liveCommand.pluginId !== pluginId ||
          liveCommand.action !== action
        ) {
          return c.json(
            errorBody(
              `command "${body.commandId}" changed while the request was waiting`,
              { code: "command_changed" },
            ),
            409,
          );
        }
        const parsed = parseSessionCommandInvocation(
          liveCommand,
          body,
          commandInvocationId!,
        );
        if (!parsed.ok) {
          return c.json(
            errorBody(parsed.message, {
              code: parsed.code.replaceAll("-", "_"),
            }),
            400,
          );
        }
        liveInvocation = parsed.invocation;
        const pluginRegistry = c.get("pluginRegistry");
        pluginRegistry.syncSessionActivations(sessionId, liveActivePlugins);
        activeRuntimes = pluginRegistry.getActiveRuntimes(sessionId);
      }
      const environment = liveCommand
        ? buildCommandEnvironment({
            command: liveCommand,
            session: liveSession,
            activeRuntimes,
            resolveModel: c.get("resolveModel"),
          })
        : undefined;
      const dispatch = () =>
        executor.dispatch(
          {
            pluginId,
            action,
            payload: body.kind === "command" ? liveInvocation : body.payload,
          },
          // session.locale lets framework defaults (submit-form) localize their
          // produced narrative; resolution order request → session → world → app.
          {
            sessionId,
            store: rpcStore,
            locale: liveSession.locale,
            ...(liveInvocation ? { command: liveInvocation } : {}),
            ...(environment ? { environment } : {}),
          },
        );
      const eventBus = c.get("eventBus");
      const dispatched =
        liveCommand && liveInvocation
          ? await runTracedCommand({
              store,
              ...(eventBus ? { eventBus } : {}),
              sessionId,
              command: liveCommand,
              invocation: liveInvocation,
              dispatch,
            })
          : await dispatch();
      if (!liveCommand) return { dispatched };

      // Re-read after the handler: commands may change session model/runtime
      // state through governed framework actions. The response snapshot is
      // therefore the environment AFTER execution, while the handler saw the
      // immutable pre-execution snapshot above.
      const postSession = await store.getSession(sessionId);
      if (!postSession) return { dispatched };
      const pluginRegistry = c.get("pluginRegistry");
      pluginRegistry.syncSessionActivations(
        sessionId,
        postSession.activePlugins ?? [],
      );
      const postEnvironment = buildCommandEnvironment({
        command: liveCommand,
        session: postSession,
        activeRuntimes: pluginRegistry.getActiveRuntimes(sessionId),
        resolveModel: c.get("resolveModel"),
      });
      return { dispatched, environment: postEnvironment };
    };
    const actionSessionLock = c.get("sessionLock");
    const dispatchResult = actionSessionLock
      ? await actionSessionLock.withLock(sessionId, dispatchAction)
      : await dispatchAction();
    if (dispatchResult instanceof Response) return dispatchResult;
    return c.json({
      status: "ok",
      result: dispatchResult.dispatched.result,
      ...(dispatchResult.environment
        ? { environment: dispatchResult.environment }
        : {}),
    });
  } catch (err) {
    if (err instanceof RpcValidationError) {
      return c.json(errorBody(err.message), 400);
    }
    if (err instanceof RpcDispatchError) {
      const httpStatus = err.code === "unknown-action" ? 404 : 500;
      return c.json(
        errorBody(err.message, { code: err.code.replaceAll("-", "_") }),
        httpStatus,
      );
    }
    return c.json(
      errorBody(
        err instanceof Error ? err.message : "plugin-rpc dispatch failed",
      ),
      500,
    );
  }
}
