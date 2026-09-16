import type { Context } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import {
  getPluginTrustInfo,
  resolveRuntimeProviders,
} from "@covel/plugin-loader";
import type { SessionRecord } from "@covel/store";
import type { ValidatedActionRequest } from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import { pluginManifestRecords } from "../../misc-api/registry-projection.js";
import {
  checkHostedOperator,
  sessionApprovalScope,
} from "../session/session-guard.js";

/** Ask before opening the stream or making any turn/domain writes. */
export function preflightActionApprovals(
  c: Context,
  session: SessionRecord,
  request: ValidatedActionRequest,
): Response | undefined {
  const registry = c.get("pluginRegistry");
  const gate = c.get("rpcApprovalGate");
  const manifests = resolveRuntimeProviders(
    session.activePlugins.flatMap((id) => {
      const entry = registry.get(id);
      return entry
        ? pluginManifestRecords(entry).map((record) => record.manifest)
        : [];
    }),
  );
  for (const manifest of manifests) {
    // Manual runtimes still need their own RPC grant. An explicit retry is the
    // exception: it may target a manual runtime through this action endpoint.
    const retryTargets =
      request.type === "retry_runtime"
        ? [request.payload.runtimeId]
        : request.type === "retry_failed_runtimes"
          ? request.payload.runtimeIds
          : undefined;
    if (
      retryTargets
        ? !retryTargets.includes(manifest.name)
        : manifest.trigger?.type === "manual"
    )
      continue;
    const trust = getPluginTrustInfo(
      manifest.pluginId,
      registry.get(manifest.pluginId)?.source,
    );
    if (trust.autoLoad) continue;
    const denied = checkHostedOperator(c);
    if (denied) return denied;
    const scope = sessionApprovalScope(session, manifest.pluginId);
    for (const action of [
      COMMUNITY_SERVER_CODE_ACTION,
      `runtime:${manifest.name}`,
    ]) {
      if (gate.hasGrant(session.id, manifest.pluginId, action, scope)) continue;
      const verdict = gate.evaluate({
        sessionId: session.id,
        sessionScope: scope,
        pluginId: manifest.pluginId,
        action,
        payload: { operation: "session-action" },
        trustLevel: trust.source,
        description: `Authorize ${action} for this session`,
      });
      if (verdict.status === "pending")
        return c.json(
          {
            status: "approval-required",
            approvalId: verdict.approvalId,
            pending: verdict.pending,
          },
          202,
        );
      if (verdict.status === "rejected")
        return c.json(
          errorBody(
            "Resolve pending approvals before starting another action",
            { code: "approval_queue_full" },
          ),
          429,
        );
    }
  }
}
