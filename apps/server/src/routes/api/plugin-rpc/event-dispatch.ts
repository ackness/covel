import type { Context } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { snapshotUserSettings } from "@covel/runtime";
import type { PluginRpcEventRequest } from "@covel/shared";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import type { SessionRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import {
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "../plugin-user-settings.js";
import {
  checkHostedOperator,
  sessionApprovalScope,
} from "../session/session-guard.js";
import { RuntimeJobQueueFullError } from "./jobs.js";
import { enqueueEventFollowers } from "./runtime-job-enqueue.js";
import {
  SessionApprovalScopeChangedError,
  SessionNotActiveError,
} from "./runtime-turn.js";
import {
  announceQueuedRuntimeJobs,
  withSettledSessionLock,
} from "./settled-request.js";

/**
 * Event-level plugin RPC: a plugin's own UI emits one of the domain events
 * that plugin declares.
 *
 * The event is delivered the way an emitted event reaches a background
 * follower: every active runtime that subscribes to the topic is queued as a
 * durable event job, in one transaction, and runs with the event as its
 * trigger. Nothing runs in the request, so the call returns as soon as the
 * jobs exist; their progress streams as `job-status.updated`.
 *
 * Like a manual runtime call, the click is the trigger decision: subscriber
 * throttles (`startTurn`, `maxTriggerCount`, `cooldownTurns`) do not apply.
 *
 * A community emitter needs a grant for the event, and every community
 * subscriber needs the same two grants a manual call of that runtime would —
 * the runtime loader refuses to run it otherwise. The request asks for the
 * first missing one; the client approves and retries until none is left.
 */
export async function dispatchPluginEvent(
  c: Context,
  session: SessionRecord,
  body: PluginRpcEventRequest,
  playerSettings:
    Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Promise<Response> {
  const store = c.get("store");
  const sessionId = session.id;
  const pluginRegistry = c.get("pluginRegistry");
  const sessionLock = c.get("sessionLock");
  const data = body.payload ?? {};

  // Reconcile activations under the session lock, as the runtime branch does,
  // so a plugin disabled by a concurrent request cannot emit or receive.
  const activeRuntimes = await withSettledSessionLock(
    c,
    sessionId,
    async () => {
      const live = await store.getSession(sessionId);
      pluginRegistry.syncSessionActivations(
        sessionId,
        (live?.activePlugins as readonly string[] | undefined) ?? [],
      );
      return pluginRegistry.getActiveRuntimes(sessionId);
    },
  );

  const directory = c.get("eventDirectory");
  if (!directory) {
    return c.json(
      errorBody("event directory is not available", {
        code: "event_directory_unavailable",
      }),
      503,
    );
  }
  // A UI may only speak for its own plugin: the topic must be one this plugin
  // declares. Other plugins take part by subscribing to it.
  const checked = await directory.validateOwn(
    sessionId,
    body.pluginId,
    body.topic,
    data,
  );
  if (!checked.ok) {
    return c.json(
      errorBody(checked.reason, {
        code:
          checked.code === "not-declared"
            ? "event_not_declared"
            : "event_payload_invalid",
      }),
      checked.code === "not-declared" ? 404 : 400,
    );
  }

  // Approval gate — same trust rule as the other kinds: trust comes from the
  // discovery source, and a community plugin needs the server-code grant
  // before a per-event grant.
  const entry = pluginRegistry.get(body.pluginId);
  const trustInfo = getPluginTrustInfo(body.pluginId, entry?.source);
  if (trustInfo.source === "community") {
    const operatorDenied = checkHostedOperator(c);
    if (operatorDenied) return operatorDenied;
  }
  const gate = c.get("rpcApprovalGate");
  const approvalScope = sessionApprovalScope(session, body.pluginId);
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
      : `event:${body.topic}`,
    payload: data,
    trustLevel: trustInfo.source,
    description: needsServerCodeGrant
      ? `Load server-side code for community plugin ${body.pluginId}`
      : `Emit event ${body.topic}`,
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

  const subscribers = activeRuntimes.filter(
    (runtime) =>
      runtime.trigger?.type === "event" && runtime.trigger.topic === body.topic,
  );
  for (const runtime of subscribers) {
    const source = getPluginTrustInfo(
      runtime.pluginId,
      pluginRegistry.get(runtime.pluginId)?.source,
    ).source;
    if (source !== "community") continue;
    const operatorDenied = checkHostedOperator(c);
    if (operatorDenied) return operatorDenied;
    const scope = sessionApprovalScope(session, runtime.pluginId);
    const needsServerCode = !gate.hasGrant(
      sessionId,
      runtime.pluginId,
      COMMUNITY_SERVER_CODE_ACTION,
      scope,
    );
    const subscriberVerdict = gate.evaluate({
      sessionId,
      sessionScope: scope,
      pluginId: runtime.pluginId,
      action: needsServerCode
        ? COMMUNITY_SERVER_CODE_ACTION
        : `runtime:${runtime.name}`,
      payload: data,
      trustLevel: source,
      description: needsServerCode
        ? `Load server-side code for community plugin ${runtime.pluginId}`
        : runtime.description,
    });
    if (subscriberVerdict.status === "pending") {
      return c.json(
        {
          status: "approval-required",
          approvalId: subscriberVerdict.approvalId,
          pending: subscriberVerdict.pending,
        },
        202,
      );
    }
    if (subscriberVerdict.status === "rejected") {
      return c.json(
        errorBody(
          `approval queue is full (limit ${subscriberVerdict.limit}); try again after resolving pending approvals`,
          { code: "queue_full" },
        ),
        429,
      );
    }
  }
  // The emission has no turn of its own; this id is what its jobs name as
  // their origin.
  const eventId = crypto.randomUUID();
  if (subscribers.length === 0) {
    return c.json({
      status: "ok",
      eventId,
      topic: body.topic,
      deferredJobs: [],
    });
  }

  const world = session.worldId ? await store.getWorld(session.worldId) : null;
  const userSettings = mergePluginUserSettings(
    readWorldPluginSettings(world?.metadata),
    playerSettings,
  );

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
        enqueueEventFollowers(tx, {
          sessionId,
          activeRuntimes,
          followers: subscribers.map((runtime) => ({
            runtimeId: runtime.name,
            pluginId: runtime.pluginId,
            triggerEvent: { topic: body.topic, data },
          })),
          sourceTurnId: eventId,
          locale: live.locale,
          ...(userSettings
            ? { userSettings: snapshotUserSettings(userSettings) }
            : {}),
        }),
      );
    });
  } catch (err) {
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
        err instanceof Error ? err.message : "failed to enqueue event jobs",
        { code: "background_enqueue_failed" },
      ),
      500,
    );
  }
  announceQueuedRuntimeJobs(c, queued);
  return c.json({
    status: "ok",
    eventId,
    topic: body.topic,
    deferredJobs: queued.map(({ job }) => ({
      jobId: job.jobId,
      runtimeId: job.runtimeId,
    })),
  });
}
