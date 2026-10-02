import type { PluginDataRecord } from "@covel/store";
import {
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionRecordSchema,
  dimensionSettlementSummarySchema,
  dimensionSnapshotFromRecords,
  isHiddenPluginDataNamespace,
  isKernelPluginDataOwner,
} from "@covel/shared";
import type { RuntimeJobValue } from "./jobs.js";

const PUBLIC_REASON_MESSAGES = {
  "execution-failed": "Runtime job execution failed.",
  "execution-deadline-exceeded": "Runtime job execution timed out.",
  "queue-deadline-exceeded": "Runtime job timed out while waiting to execute.",
  "commit-barrier-rejected":
    "Runtime job stopped because its session or plugin state changed.",
  "pre-execution-rejected":
    "Runtime job stopped because its session or plugin state changed.",
  "worker-shutdown": "Runtime job was cancelled because its worker shut down.",
  "cancelled-by-user": "Runtime job was cancelled by the user.",
  "lease-expired":
    "Runtime job was interrupted because its worker lease expired.",
  "runtime-reported-failure": "The runtime reported a failed result.",
  "follower-not-emitted":
    "The runtime finished without queuing its follow-up job.",
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

/**
 * Retain game results and identities, excluding frozen inputs and raw failures.
 * A prompt-builder queued with `expectsBackgroundFollower` is marked
 * `phase: "prompt"` so panels can say what it is doing.
 */
export function publicRuntimeJob<T extends RuntimeJobValue>(
  job: T,
): Omit<T, "payload" | "error" | "reason"> &
  PublicRuntimeJobDiagnostics & { readonly phase?: "prompt" } {
  const { payload, error: _error, reason: _reason, ...visible } = job;
  const expectsFollower =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { expectFollower?: unknown }).expectFollower === true;
  return {
    ...visible,
    ...(expectsFollower ? { phase: "prompt" as const } : {}),
    ...publicRuntimeJobDiagnostics(job),
  };
}

/**
 * Hidden world data and kernel bookkeeping never cross a public boundary:
 * callers drop these rows from listings and answer single reads as not found.
 */
export function isPublicPluginDataRecord(
  record: Pick<PluginDataRecord, "pluginId" | "namespace">,
): boolean {
  return (
    !isHiddenPluginDataNamespace(record.namespace) &&
    !isKernelPluginDataOwner(record.pluginId)
  );
}

/** Apply the same boundary to generic plugin-data reads used by Web hydration. */
export function publicPluginDataValue(
  record: Pick<PluginDataRecord, "namespace" | "value">,
): unknown {
  // Dimension records are framework-owned (`_` namespace) but still readable
  // for UI hydration. Project them to their PUBLIC shape: a dimension row
  // exposes only the snapshot entry (name/schema/value/version) — never the
  // updateRule, initialValue, or lastTrackedSource — and a settlement row
  // exposes only the summary, never the frozen definitions/readVersions/narrative.
  if (record.namespace === DIMENSION_DATA_NAMESPACE) {
    const parsed = dimensionRecordSchema.safeParse(record.value);
    if (!parsed.success) return undefined;
    return dimensionSnapshotFromRecords({ ["_"]: parsed.data })["_"];
  }
  if (record.namespace === DIMENSION_SETTLEMENT_NAMESPACE) {
    const parsed = dimensionSettlementSummarySchema.safeParse(record.value);
    return parsed.success ? parsed.data : undefined;
  }
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
