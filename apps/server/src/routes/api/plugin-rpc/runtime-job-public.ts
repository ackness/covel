import type { PluginDataRecord } from "@covel/store";
import type { RuntimeJobValue } from "./jobs.js";

const PUBLIC_REASON_MESSAGES = {
  "execution-failed": "Runtime job execution failed.",
  "execution-deadline-exceeded": "Runtime job execution timed out.",
  "queue-deadline-exceeded": "Runtime job timed out while waiting to execute.",
  "commit-barrier-rejected":
    "Runtime job stopped because its session or plugin state changed.",
  "worker-shutdown": "Runtime job was cancelled because its worker shut down.",
  "cancelled-by-user": "Runtime job was cancelled by the user.",
  "lease-expired":
    "Runtime job was interrupted because its worker lease expired.",
} as const;

export interface PublicRuntimeJobDiagnostics {
  readonly reason?: keyof typeof PUBLIC_REASON_MESSAGES;
  readonly error?: string;
}

/** Public diagnostics never use provider messages or arbitrary handler text. */
export function publicRuntimeJobDiagnostics(
  job: Pick<RuntimeJobValue, "status" | "reason">,
): PublicRuntimeJobDiagnostics {
  let fallback: string;
  switch (job.status) {
    case "failed":
      fallback = "Runtime job execution failed.";
      break;
    case "timed_out":
      fallback = "Runtime job timed out.";
      break;
    case "stale":
      fallback =
        "Runtime job stopped because its session or plugin state changed.";
      break;
    case "orphaned":
      fallback =
        "Runtime job was interrupted because its worker lease expired.";
      break;
    case "cancelled":
      fallback = "Runtime job was cancelled.";
      break;
    default:
      return {};
  }
  const reason =
    job.reason && Object.hasOwn(PUBLIC_REASON_MESSAGES, job.reason)
      ? (job.reason as keyof typeof PUBLIC_REASON_MESSAGES)
      : undefined;
  return {
    ...(reason ? { reason } : {}),
    error: reason ? PUBLIC_REASON_MESSAGES[reason] : fallback,
  };
}

/** Retain game results and identities, excluding frozen inputs and raw failures. */
export function publicRuntimeJob<T extends RuntimeJobValue>(
  job: T,
): Omit<T, "payload" | "error" | "reason"> & PublicRuntimeJobDiagnostics {
  const { payload: _payload, error: _error, reason: _reason, ...visible } = job;
  return { ...visible, ...publicRuntimeJobDiagnostics(job) };
}

/** Apply the same boundary to generic plugin-data reads used by Web hydration. */
export function publicPluginDataValue(
  record: Pick<PluginDataRecord, "namespace" | "value">,
): unknown {
  if (record.namespace !== "_runtime_jobs") return record.value;
  if (
    !record.value ||
    typeof record.value !== "object" ||
    Array.isArray(record.value)
  ) {
    throw new Error("Invalid persisted runtime job value");
  }
  return publicRuntimeJob(record.value as RuntimeJobValue);
}
