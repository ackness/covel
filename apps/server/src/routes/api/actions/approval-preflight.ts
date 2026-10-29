import { approvalVerdictResponse } from "../approval-verdict.js";
import {
  pluginRuntimeManifests,
  getPluginTrustInfo,
  resolveRuntimeProviders,
} from "@covel/plugin-loader";
import type { Context } from "hono";
import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import type { SessionRecord } from "@covel/store";
import type { RuntimeManifest, ValidatedActionRequest } from "@covel/shared";
import { sessionApprovalScope } from "../session/session-guard.js";
import { runnablePluginIds } from "../session/plugins.js";
import { requireAccess } from "../../../host-profile.js";

/** Ask before opening the stream or making any turn/domain writes. */
export async function preflightActionApprovals(
  c: Context,
  session: SessionRecord,
  request: ValidatedActionRequest,
): Promise<Response | undefined> {
  // Manual runtimes need their own RPC grant unless explicitly retried.
  const retryTargets =
    request.type === "retry_runtime"
      ? [request.payload.runtimeId]
      : request.type === "retry_failed_runtimes"
        ? request.payload.runtimeIds
        : undefined;
  return preflightApprovals(
    c,
    session,
    (manifest) =>
      isSubagentProvider(manifest) ||
      (retryTargets
        ? retryTargets.includes(manifest.name)
        : manifest.trigger?.type !== "manual"),
    "session-action",
  );
}

/**
 * Check only the requested continuations, including manual runtimes, and the
 * sub-agent providers they can delegate to.
 */
export async function preflightRuntimeApprovals(
  c: Context,
  session: SessionRecord,
  runtimeIds: readonly string[],
): Promise<Response | undefined> {
  return preflightApprovals(
    c,
    session,
    (manifest) =>
      runtimeIds.includes(manifest.name) || isSubagentProvider(manifest),
    "resume",
  );
}

/**
 * Check the sub-agent providers a manual runtime run can delegate to. The
 * route asks for its explicit target's grants itself.
 */
export async function preflightSubagentApprovals(
  c: Context,
  session: SessionRecord,
): Promise<Response | undefined> {
  return preflightApprovals(c, session, isSubagentProvider, "manual-runtime");
}

/**
 * A sub-agent provider runs inside any execution of the session, whichever
 * runtime its caller is, so every execution admits it up front. The runtime
 * loader still refuses it without both grants.
 */
function isSubagentProvider(manifest: RuntimeManifest): boolean {
  return manifest.subagentOnly === true;
}

async function preflightApprovals(
  c: Context,
  session: SessionRecord,
  selected: (manifest: RuntimeManifest) => boolean,
  operation: string,
): Promise<Response | undefined> {
  const registry = c.get("pluginRegistry");
  const gate = c.get("rpcApprovalGate");
  const manifests = resolveRuntimeProviders(
    runnablePluginIds(session.activePlugins, registry).flatMap((id) => {
      const entry = registry.get(id);
      return entry
        ? pluginRuntimeManifests(entry).map((record) => record.manifest)
        : [];
    }),
  );
  const refreshed = new Set<string>();
  for (const manifest of manifests) {
    if (!selected(manifest)) continue;
    const trust = getPluginTrustInfo(
      manifest.pluginId,
      registry.get(manifest.pluginId)?.source,
    );
    if (trust.autoLoad) continue;
    const denied = requireAccess(c, "plugin.community");
    if (denied) return denied;
    if (!refreshed.has(manifest.pluginId)) {
      await c.get("trustedSources")?.ensureFresh(manifest.pluginId);
      refreshed.add(manifest.pluginId);
    }
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
        payload: { operation },
        trustLevel: trust.source,
        description: `Authorize ${action} for this session`,
      });
      const verdictResponse = approvalVerdictResponse(c, verdict, {
        message: "Resolve pending approvals before starting another action",
        code: "approval_queue_full",
      });
      if (verdictResponse) return verdictResponse;
    }
  }
}
