import type {
  PluginRpcDeferredJob,
  PluginRpcRequest,
  PluginRpcResponse,
} from "@covel/shared";
import { postPluginRpc, resolveApproval } from "@/services/api.js";
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
  if (res.status === "error") return res.error;
  if (res.status !== "ok") return "";
  const runtimeError = res.runtimeResults?.find(
    (r) =>
      r.status === "failed" ||
      (typeof r.error === "string" && r.error.length > 0),
  )?.error;
  if (runtimeError) return runtimeError;
  return res.abortReason ?? "";
}

function formatJobIdList(jobs: readonly PluginRpcDeferredJob[]): string {
  const jobIds = jobs.map((j) => j.jobId).filter(Boolean);
  return (
    jobIds.slice(0, 3).join(", ") +
    (jobIds.length > 3 ? ` (+${jobIds.length - 3})` : "")
  );
}

export function emitPluginRpcAcceptedJob(t: Translate, jobId: string): void {
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

export function emitPluginRpcDeferredJobs(
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
  if (response.status === "error") {
    emitToast("error", response.error);
    return;
  }
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
  if ((response.failedJobs ?? []).length > 0) {
    emitToast(
      "error",
      t("plugin.invokeRuntime.failedJobs", {
        count: response.failedJobs?.length ?? 0,
        defaultValue:
          "{{count}} background job(s) failed. Check the job panel for details.",
      }),
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
  readonly request: PluginRpcRequest;
  readonly pluginId: string;
  readonly actionLabel: string;
  readonly confirm: ConfirmPluginRpcApproval;
  readonly t: Translate;
}): Promise<PluginRpcResponse | null> {
  const first = await postPluginRpc(params.sessionId, params.request);
  return resolvePluginRpcApprovalResponse({
    response: first,
    retry: () => postPluginRpc(params.sessionId, params.request),
    pluginId: params.pluginId,
    actionLabel: params.actionLabel,
    confirm: params.confirm,
    t: params.t,
  });
}

export async function resolvePluginRpcApprovalResponse(params: {
  readonly response: PluginRpcResponse;
  readonly retry: () => Promise<PluginRpcResponse>;
  readonly pluginId: string;
  readonly actionLabel: string;
  readonly confirm: ConfirmPluginRpcApproval;
  readonly t: Translate;
  readonly submitApproval?: typeof resolveApproval;
}): Promise<PluginRpcResponse | null> {
  if (params.response.status !== "approval-required") {
    return params.response;
  }

  const proceed = await params.confirm({
    title: params.t("plugin.approval.title", {
      defaultValue: "Authorize plugin action",
    }),
    message: params.t("plugin.approval.confirmMessage", {
      pluginId: params.pluginId,
      action: params.actionLabel,
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
      params.response.approvalId,
      proceed ? "allow" : "deny",
      "session",
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
        action: params.actionLabel,
        defaultValue: "Denied {{action}}",
      }),
    );
    return null;
  }

  const retryResponse = await params.retry();
  if (retryResponse.status === "approval-required") {
    emitToast(
      "error",
      params.t("plugin.approval.unexpectedRequired", {
        defaultValue:
          "Still got approval-required after grant - please check the approval backend",
      }),
    );
    return null;
  }
  return retryResponse;
}
