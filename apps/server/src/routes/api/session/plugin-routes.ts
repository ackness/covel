import {
  provideRequestJobCredentials,
  withSettledSessionLock,
} from "../plugin-rpc/settled-request.js";
import type { Hono } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import { errorBody, okBody } from "../../../api-error.js";
import {
  buildSessionPluginView,
  readSessionPluginSelection,
  resolveSessionPluginPlan,
  runnablePluginIds,
  storedPluginSelection,
  authorizedSessionPluginIds,
} from "./plugins.js";
import { buildSessionCommandList } from "./commands.js";
import { importWorldDataForJoinedPlugins } from "../../../world-data/receiver-import.js";
import {
  checkHostedOperator,
  resolveSessionParam,
  rotateSessionApprovalScope,
  sessionApprovalScope,
  sessionIncarnationIdentity,
  SESSION_DELETION_PENDING_KEY,
} from "./session-guard.js";
import type { SessionRouteEnv } from "./route-env.js";

/**
 * A session keeps its dimension data under the provider it bound, and turns,
 * snapshots and browser checkpoints all require that provider to be active.
 * A selection change must not take it out of the active set.
 */
function droppedDimensionProvider(
  session: {
    readonly activePlugins: readonly string[];
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
  active: readonly string[],
): string | undefined {
  const bound = session.metadata?._dimensionProviderPluginId;
  return typeof bound === "string" &&
    session.activePlugins.includes(bound) &&
    !active.includes(bound)
    ? bound
    : undefined;
}

function dimensionProviderRequired(pluginId: string) {
  return errorBody(
    `This change would disable "${pluginId}", which holds this session's dimensions and must stay enabled`,
    { code: "dimension_provider_required" },
  );
}

export function registerSessionPluginRoutes(
  routes: Hono<SessionRouteEnv>,
): void {
  // A read-only projection of the committed session record. It takes neither
  // the settle barrier nor the session lock, so a refresh during a running
  // turn gets the plugin panel and commands at once instead of waiting for
  // the turn to end. A selection change that commits later publishes its own
  // event, and the client fetches the list again.
  routes.get("/:id/plugins", async (c) => {
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    // Queued jobs may be waiting for this owner's request credentials.
    if ((await provideRequestJobCredentials(c, id)) > 0)
      c.get("runtimeJobWorker")?.wake(id);
    if (guard.session.metadata?.[SESSION_DELETION_PENDING_KEY]) {
      return c.json(
        errorBody("Session deletion is in progress", {
          code: "session_deleting",
        }),
        409,
      );
    }
    const view = buildSessionPluginView(guard.session, pluginRegistry, {
      isEntryPublished: c.get("isPluginEntryPublished"),
      authorized: authorizedSessionPluginIds(
        pluginRegistry,
        c.get("rpcApprovalGate"),
        guard.session,
      ),
    });
    return c.json({
      ...view,
      commands: buildSessionCommandList(view.resolution.active, pluginRegistry),
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
      const previouslyActive = new Set(
        runnablePluginIds(session.activePlugins, pluginRegistry),
      );
      const droppedProvider = droppedDimensionProvider(session, active);
      if (droppedProvider)
        return c.json(dimensionProviderRequired(droppedProvider), 409);
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
      // Creation skipped the world data of plugins that were not active then,
      // such as a community plugin approved after the game started. Import it
      // once for them now, still under the session lock, so no turn sees the
      // plugin without its data. The plugin stays enabled if this fails; the
      // player is told what is missing.
      const joined = active.filter(
        (activeId) => !previouslyActive.has(activeId),
      );
      let worldData;
      try {
        worldData = await importWorldDataForJoinedPlugins({
          store,
          mediaStore: c.get("mediaStore"),
          session,
          joined,
          worldsDirs: c.get("worldsDirs"),
          covelHome: c.get("covelHome"),
          now: new Date().toISOString(),
          preflight: {
            activePlugins: active,
            registry: pluginRegistry,
            canExecuteProjection: (projectionPluginId: string) =>
              c
                .get("rpcApprovalGate")
                .hasGrant(
                  id,
                  projectionPluginId,
                  COMMUNITY_SERVER_CODE_ACTION,
                  sessionApprovalScope(session, projectionPluginId),
                ),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[sessions] world-data import for ${joined.join(", ")} failed: ${message}`,
        );
        worldData = {
          receivers: [],
          imported: 0,
          conflicts: 0,
          notices: [
            {
              level: "error" as const,
              message: `World data import failed: ${message}`,
            },
          ],
        };
      }
      return c.json(
        okBody({
          activePluginIds: active,
          resolution: plan,
          ...(worldData ? { worldData } : {}),
        }),
      );
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
      const droppedProvider = droppedDimensionProvider(session, active);
      if (droppedProvider)
        return c.json(dimensionProviderRequired(droppedProvider), 409);
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
