import i18n from "i18next";
import { compactJobId, formatJobDuration } from "@/lib/job-ui.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  getPluginNamespaceSnapshot,
  type PluginDataChange,
} from "@/stores/plugin-data-store.js";

interface JobTransition {
  readonly pluginId: string;
  readonly jobId: string;
  readonly prevStatus: string | null;
  readonly nextStatus: string;
  readonly value: Record<string, unknown> | null;
}

function readJobStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export function collectJobTransitions(
  pluginId: string,
  changes: readonly PluginDataChange[],
): readonly JobTransition[] {
  const transitions: JobTransition[] = [];
  const priorSnapshot = getPluginNamespaceSnapshot(pluginId, "_jobs");
  for (const change of changes) {
    if (change.namespace !== "_jobs") continue;
    if (change.operation === "delete") continue;
    const prevStatus = readJobStatus(priorSnapshot[change.key]);
    const nextStatus = readJobStatus(change.value);
    if (!nextStatus) continue;
    if (prevStatus === nextStatus) continue;
    if (nextStatus !== "done" && nextStatus !== "failed") continue;
    transitions.push({
      pluginId,
      jobId: change.key,
      prevStatus,
      nextStatus,
      value:
        change.value && typeof change.value === "object"
          ? (change.value as Record<string, unknown>)
          : null,
    });
  }
  return transitions;
}

export function emitJobTransitionToast(tr: JobTransition): void {
  const value = tr.value ?? {};
  const runtimeId = (value.runtimeId as string | undefined) ?? "";
  const durationMs = value.durationMs as number | undefined;
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
    const errorMessage =
      (value.error as string | undefined) ??
      (value.abortReason as string | undefined) ??
      "";
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
