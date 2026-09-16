import type {
  PluginRpcDeferredJob,
  PluginRpcRequest,
  PluginRpcResponse,
} from "@covel/shared";
import {
  postPluginRpc as requestPluginRpc,
  resolveApproval,
} from "@/services/api.js";
import { getSessionWorkspace } from "@/services/data-service.js";
import { emitToast } from "@/lib/toast-channel.js";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface PluginRpcConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

export type ConfirmPluginRpcApproval = (
  params: PluginRpcConfirmRequest,
) => Promise<boolean>;

export function getPluginRpcFailureMessage(res: PluginRpcResponse): string {
  if (res.status !== "ok") return "";
  const runtimeFailure = res.runtimeResults?.find(
    (r) =>
      r.status === "failed" ||
      (typeof r.error === "string" && r.error.length > 0),
  );
  if (runtimeFailure)
    return runtimeFailure.error || `Runtime ${runtimeFailure.runtimeId} failed`;
  return res.abortReason ?? "";
}

function formatJobIdList(jobs: readonly PluginRpcDeferredJob[]): string {
  const jobIds = jobs.map((j) => j.jobId).filter(Boolean);
  return (
    jobIds.slice(0, 3).join(", ") +
    (jobIds.length > 3 ? ` (+${jobIds.length - 3})` : "")
  );
}

function emitPluginRpcAcceptedJob(t: Translate, jobId: string): void {
  emitToast(
    "info",
    t("plugin.invokeRuntime.submitted", {
      count: 1,
      ids: jobId,
      defaultValue:
        "Submitted {{count}} background job(s): {{ids}}. Waiting for completion...",
    }),
  );
}

function emitPluginRpcDeferredJobs(
  t: Translate,
  jobs: readonly PluginRpcDeferredJob[],
): void {
  emitToast(
    "info",
    t("plugin.invokeRuntime.submitted", {
      count: jobs.length,
      ids: formatJobIdList(jobs),
      defaultValue:
        "Submitted {{count}} background job(s): {{ids}}. Waiting for completion...",
    }),
  );
}

export function emitPluginRpcRuntimeResponse(params: {
  readonly response: PluginRpcResponse;
  readonly t: Translate;
  readonly runtimeId: string;
  readonly expectsBackgroundFollower?: boolean;
  readonly fallbackFailureMessage?: string;
}): void {
  const { response, t, runtimeId } = params;
  if (response.status === "accepted") {
    emitPluginRpcAcceptedJob(t, response.jobId);
    return;
  }
  if (response.status !== "ok") return;

  const failureMessage = getPluginRpcFailureMessage(response);
  if (failureMessage) {
    emitToast(
      "error",
      failureMessage || params.fallbackFailureMessage || "Plugin RPC failed",
    );
    return;
  }
  const deferredJobs = response.deferredJobs ?? [];
  if (params.expectsBackgroundFollower === true && deferredJobs.length === 0) {
    emitToast(
      "error",
      t("plugin.invokeRuntime.noFollowerEvents", {
        runtimeId,
        defaultValue:
          "{{runtimeId}} finished but emitted no background follower (missing matching events[]). Check that the model output a valid JSON envelope.",
      }),
    );
    return;
  }
  if (deferredJobs.length > 0) {
    emitPluginRpcDeferredJobs(t, deferredJobs);
  }
}

export async function postPluginRpcWithApproval(params: {
  readonly sessionId: string;
  /** Prepare uploads inside the hydrated workspace; may run again after approval. */
  readonly request: PluginRpcRequest | (() => Promise<PluginRpcRequest>);
  readonly pluginId: string;
  readonly actionLabel: string;
  readonly confirm: ConfirmPluginRpcApproval;
  readonly t: Translate;
}): Promise<PluginRpcResponse | null> {
  const postPluginRpc = () =>
    getSessionWorkspace().run(
      params.sessionId,
      `plugin-rpc:${crypto.randomUUID()}`,
      async () =>
        requestPluginRpc(
          params.sessionId,
          typeof params.request === "function"
            ? await params.request()
            : params.request,
        ),
    );
  const first = await postPluginRpc();
  return resolvePluginRpcApprovalResponse({
    response: first,
    sessionId: params.sessionId,
    retry: postPluginRpc,
    pluginId: params.pluginId,
    actionLabel: params.actionLabel,
    confirm: params.confirm,
    t: params.t,
  });
}

export async function resolvePluginRpcApprovalResponse(params: {
  readonly response: PluginRpcResponse;
  readonly sessionId?: string;
  readonly retry: () => Promise<PluginRpcResponse>;
  readonly pluginId: string;
  readonly actionLabel: string;
  readonly confirm: ConfirmPluginRpcApproval;
  readonly t: Translate;
  readonly submitApproval?: typeof resolveApproval;
}): Promise<PluginRpcResponse | null> {
  let response = params.response;
  const requested = new Set<string>();
  while (response.status === "approval-required") {
    const pending =
      response.pending && typeof response.pending === "object"
        ? (response.pending as Record<string, unknown>)
        : undefined;
    const approvedPluginId =
      typeof pending?.pluginId === "string"
        ? pending.pluginId
        : params.pluginId;
    const approvedAction =
      typeof pending?.action === "string" ? pending.action : params.actionLabel;
    const key = JSON.stringify([approvedPluginId, approvedAction]);
    // A batch may need several providers. Stop on a repeated grant instead of
    // imposing a plugin count; never approve a response for another session.
    if (
      requested.has(key) ||
      (params.sessionId &&
        typeof pending?.sessionId === "string" &&
        pending.sessionId !== params.sessionId)
    )
      break;
    requested.add(key);

    const proceed = await params.confirm({
      title: params.t("plugin.approval.title", {
        defaultValue: "Authorize plugin action",
      }),
      message: params.t("plugin.approval.confirmMessage", {
        pluginId: approvedPluginId,
        action: approvedAction,
        defaultValue:
          "Plugin {{pluginId}} requests permission to run {{action}}. Authorize all matching calls for this session?",
      }),
      confirmLabel: params.t("plugin.approval.allow", {
        defaultValue: "Authorize",
      }),
      cancelLabel: params.t("plugin.approval.deny", {
        defaultValue: "Deny",
      }),
    });

    try {
      await (params.submitApproval ?? resolveApproval)(
        response.approvalId,
        proceed ? "allow" : "deny",
        "session",
        params.sessionId,
      );
    } catch (err) {
      emitToast(
        "error",
        params.t("plugin.approval.submitFailed", {
          error: err instanceof Error ? err.message : String(err),
          defaultValue: "Approval submission failed: {{error}}",
        }),
      );
      return null;
    }

    if (!proceed) {
      emitToast(
        "info",
        params.t("plugin.approval.denied", {
          action: approvedAction,
          defaultValue: "Denied {{action}}",
        }),
      );
      return null;
    }

    response = await params.retry();
  }

  if (response.status === "approval-required") {
    emitToast(
      "error",
      params.t("plugin.approval.unexpectedRequired", {
        defaultValue:
          "Still got approval-required after grant - please check the approval backend",
      }),
    );
    return null;
  }
  return response;
}
