import type { Hono } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { errorBody, okBody } from "../../../api-error.js";
import {
  approvedActivePlugins,
  buildAvailablePluginList,
  isRequiredCorePlugin,
  resolveEnabledSessionPlugins,
} from "./plugins.js";
import { buildSessionCommandList } from "./commands.js";
import {
  checkHostedOperator,
  resolveSessionParam,
  rotateSessionApprovalScope,
  sessionApprovalScope,
  sessionIncarnationIdentity,
  SESSION_DELETION_PENDING_KEY,
} from "./session-guard.js";
import type { SessionRouteEnv } from "./route-env.js";

export function registerSessionPluginRoutes(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.get("/:id/plugins", async (c) => {
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const expectedIncarnation = sessionIncarnationIdentity(guard.session);
    return c.get("sessionLock").withLock(id, async () => {
      const lockedGuard = await resolveSessionParam(c);
      if (!lockedGuard.ok) return lockedGuard.response;
      if (
        sessionIncarnationIdentity(lockedGuard.session) !== expectedIncarnation
      ) {
        return c.json(
          errorBody("Session was replaced while the request was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (lockedGuard.session.metadata?.[SESSION_DELETION_PENDING_KEY]) {
        return c.json(
          errorBody("Session deletion is in progress", {
            code: "session_deleting",
          }),
          409,
        );
      }
      const active = approvedActivePlugins(
        lockedGuard.session.activePlugins,
        pluginRegistry,
        c.get("rpcApprovalGate"),
        lockedGuard.session,
      );
      return c.json({
        items: buildAvailablePluginList(active, pluginRegistry),
        commands: buildSessionCommandList(active, pluginRegistry),
      });
    });
  });

  routes.put("/:id/plugins/:pluginId", async (c) => {
    const store = c.get("store");
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const pluginId = c.req.param("pluginId");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const expectedIncarnation = sessionIncarnationIdentity(guard.session);
    const pluginEntry = pluginRegistry.get(pluginId);
    if (!pluginEntry) {
      return c.json(
        errorBody(`Plugin "${pluginId}" not found`, {
          code: "plugin_not_found",
        }),
        404,
      );
    }

    const trust = getPluginTrustInfo(pluginId, pluginEntry.source);
    if (trust.source === "community") {
      const operatorDenied = checkHostedOperator(c);
      if (operatorDenied) return operatorDenied;
    }
    const approvalScope = sessionApprovalScope(guard.session, pluginId);
    const verdict = c.get("rpcApprovalGate").evaluate({
      sessionId: id,
      sessionScope: approvalScope,
      pluginId,
      action: COMMUNITY_SERVER_CODE_ACTION,
      payload: { operation: "enable" },
      trustLevel: trust.source,
      description: `Enable server-side code for plugin ${pluginId}`,
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
          `approval queue is full (limit ${verdict.limit}); resolve pending approvals and retry`,
          { code: "approval_queue_full" },
        ),
        429,
      );
    }

    await c.get("activatePluginServerCode")?.(pluginId, id);
    return c.get("sessionLock").withLock(id, async () => {
      const lockedGuard = await resolveSessionParam(c);
      if (!lockedGuard.ok) return lockedGuard.response;
      const session = lockedGuard.session;
      if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
        return c.json(
          errorBody("Session was replaced while enable was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (
        session.status !== "active" ||
        session.metadata?.[SESSION_DELETION_PENDING_KEY]
      ) {
        return c.json(
          errorBody(`Session is ${session.status}; plugin enable refused`, {
            code: session.metadata?.[SESSION_DELETION_PENDING_KEY]
              ? "session_deleting"
              : "session_not_active",
          }),
          409,
        );
      }
      if (
        trust.source === "community" &&
        sessionApprovalScope(session, pluginId) !== approvalScope
      ) {
        return c.json(
          errorBody("Approval scope changed while enabling the plugin", {
            code: "approval_scope_changed",
          }),
          409,
        );
      }

      const active = resolveEnabledSessionPlugins(
        session.activePlugins,
        pluginId,
        pluginRegistry,
      );
      await store.updateSession(id, {
        activePlugins: active,
        updatedAt: new Date().toISOString(),
      });
      for (const activePluginId of active) {
        pluginRegistry.activate(activePluginId, id);
      }
      for (const previousPluginId of session.activePlugins) {
        if (!active.includes(previousPluginId)) {
          pluginRegistry.deactivate(previousPluginId, id);
          c.get("rpcApprovalGate").revoke(id, previousPluginId);
        }
      }
      return c.json(okBody({ activePluginIds: active }));
    });
  });

  routes.delete("/:id/plugins/:pluginId", async (c) => {
    const store = c.get("store");
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const pluginId = c.req.param("pluginId");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const expectedIncarnation = sessionIncarnationIdentity(guard.session);
    const entry = pluginRegistry.get(pluginId);
    if (entry && isRequiredCorePlugin(entry)) {
      return c.json(
        errorBody(`Cannot disable core plugin "${pluginId}"`, {
          code: "core_plugin_required",
        }),
        403,
      );
    }

    return c.get("sessionLock").withLock(id, async () => {
      const lockedGuard = await resolveSessionParam(c);
      if (!lockedGuard.ok) return lockedGuard.response;
      const session = lockedGuard.session;
      if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
        return c.json(
          errorBody("Session was replaced while disable was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      if (
        session.status !== "active" ||
        session.metadata?.[SESSION_DELETION_PENDING_KEY]
      ) {
        return c.json(
          errorBody(`Session is ${session.status}; plugin disable refused`, {
            code: session.metadata?.[SESSION_DELETION_PENDING_KEY]
              ? "session_deleting"
              : "session_not_active",
          }),
          409,
        );
      }

      const active = session.activePlugins.filter((item) => item !== pluginId);
      await store.updateSession(id, {
        activePlugins: active,
        metadata: rotateSessionApprovalScope(session, pluginId),
        updatedAt: new Date().toISOString(),
      });
      pluginRegistry.deactivate(pluginId, id);
      c.get("rpcApprovalGate").revoke(id, pluginId);
      return c.json(okBody({ activePluginIds: active }));
    });
  });
}
