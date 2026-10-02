import i18n from "i18next";
import { compactJobId, formatJobDuration } from "@/lib/job-ui.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  backgroundJobRecord,
  getPluginNamespaceSnapshot,
  type PluginDataChange,
  type PluginJobRecord,
} from "@/stores/plugin-data-store.js";

interface JobTransition {
  readonly pluginId: string;
  readonly jobId: string;
  readonly prevStatus: string | null;
  readonly nextStatus: string;
  readonly job: PluginJobRecord;
}

/** Background jobs that reached a terminal state in this change batch. */
export function collectJobTransitions(
  pluginId: string,
  changes: readonly PluginDataChange[],
): readonly JobTransition[] {
  const transitions: JobTransition[] = [];
  const priorSnapshot = getPluginNamespaceSnapshot(pluginId, "_runtime_jobs");
  for (const change of changes) {
    if (change.namespace !== "_runtime_jobs") continue;
    if (change.operation === "delete") continue;
    const job = backgroundJobRecord(change.key, change.value);
    if (!job || job.status === "pending") continue;
    const prevStatus =
      backgroundJobRecord(change.key, priorSnapshot[change.key])?.status ??
      null;
    if (prevStatus === job.status) continue;
    transitions.push({
      pluginId,
      jobId: change.key,
      prevStatus,
      nextStatus: job.status,
      job,
    });
  }
  return transitions;
}

export function emitJobTransitionToast(tr: JobTransition): void {
  const runtimeId = tr.job.runtimeId ?? "";
  const durationMs = tr.job.durationMs;
  const shortId = compactJobId(tr.jobId, {
    maxLength: 14,
    prefixLength: 14,
  });
  const target = runtimeId
    ? `${runtimeId} · ${shortId}`
    : `${tr.pluginId} · ${shortId}`;
  if (tr.nextStatus === "done") {
    emitToast(
      "success",
      i18n.t("pluginJob.completed", {
        target,
        duration: formatJobDuration(durationMs, {
          emptyValue: "—",
          style: "fixed",
        }),
        defaultValue: "{{target}} completed in {{duration}}",
      }),
    );
  } else if (tr.nextStatus === "failed") {
    const errorMessage = tr.job.error ?? tr.job.abortReason ?? "";
    const trimmedError =
      errorMessage.length > 200
        ? `${errorMessage.slice(0, 200)}…`
        : errorMessage;
    emitToast(
      "error",
      i18n.t("pluginJob.failed", {
        target,
        error:
          trimmedError ||
          i18n.t("pluginJob.unknownError", { defaultValue: "unknown error" }),
        defaultValue: "{{target}} failed: {{error}}",
      }),
    );
  }
}
