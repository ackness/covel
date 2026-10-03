import { withSettledSessionLock } from "../plugin-rpc/settled-request.js";
import type { Hono } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { errorBody, okBody } from "../../../api-error.js";
import {
  buildSessionPluginView,
  readSessionPluginSelection,
  resolveSessionPluginPlan,
  storedPluginSelection,
  authorizedSessionPluginIds,
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
    return withSettledSessionLock(c, id, async () => {
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
      const view = buildSessionPluginView(lockedGuard.session, pluginRegistry, {
        isEntryPublished: c.get("isPluginEntryPublished"),
        authorized: authorizedSessionPluginIds(
          pluginRegistry,
          c.get("rpcApprovalGate"),
          lockedGuard.session,
        ),
      });
      return c.json({
        ...view,
        commands: buildSessionCommandList(
          view.resolution.active,
          pluginRegistry,
        ),
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
    return withSettledSessionLock(c, id, async () => {
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

      const selection = readSessionPluginSelection(session);
      const requested = [
        pluginId,
        ...selection.requested.filter((id) => id !== pluginId),
      ];
      const excluded = selection.excluded.filter((id) => id !== pluginId);
      const { requiredContracts } = selection;
      const plan = resolveSessionPluginPlan(requested, pluginRegistry, {
        excluded,
        requiredContracts,
        authorized: authorizedSessionPluginIds(
          pluginRegistry,
          c.get("rpcApprovalGate"),
          session,
        ),
      });
      const rejected = plan.rejected.find((item) => item.pluginId === pluginId);
      if (rejected)
        return c.json(errorBody(rejected.reason, { code: rejected.code }), 409);
      const active = plan.active;
      // Single mutation point: persist the authoritative activePlugins set
      // first; the registry mirror only reconciles after the store write
      // succeeds (a rejected write leaves memory untouched).
      await pluginRegistry.applyPersistedActivations(id, active, async () => {
        await store.updateSession(id, {
          activePlugins: active,
          metadata: {
            ...session.metadata,
            pluginSelection: storedPluginSelection({
              requested,
              excluded,
              requiredContracts,
            }),
          },
          updatedAt: new Date().toISOString(),
        });
      });
      for (const previousPluginId of session.activePlugins) {
        if (!active.includes(previousPluginId)) {
          c.get("rpcApprovalGate").revoke(id, previousPluginId);
        }
      }
      c.get("uiSlots")?.invalidateSession(id);
      return c.json(okBody({ activePluginIds: active, resolution: plan }));
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
    return withSettledSessionLock(c, id, async () => {
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

      const selection = readSessionPluginSelection(session);
      const requested = selection.requested.filter((id) => id !== pluginId);
      const excluded = [...new Set([...selection.excluded, pluginId])];
      const { requiredContracts } = selection;
      const plan = resolveSessionPluginPlan(requested, pluginRegistry, {
        excluded,
        requiredContracts,
        authorized: authorizedSessionPluginIds(
          pluginRegistry,
          c.get("rpcApprovalGate"),
          session,
        ),
      });
      const active = plan.active;
      // Single mutation point: the scope rotation and activePlugins write
      // land durably before the registry mirror drops the plugin.
      await pluginRegistry.applyPersistedActivations(id, active, async () => {
        await store.updateSession(id, {
          activePlugins: active,
          metadata: {
            ...rotateSessionApprovalScope(session, pluginId),
            pluginSelection: storedPluginSelection({
              requested,
              excluded,
              requiredContracts,
            }),
          },
          updatedAt: new Date().toISOString(),
        });
      });
      c.get("rpcApprovalGate").revoke(id, pluginId);
      c.get("uiSlots")?.invalidateSession(id);
      return c.json(okBody({ activePluginIds: active, resolution: plan }));
    });
  });
}
