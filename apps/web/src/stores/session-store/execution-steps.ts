import type { ExecutionStep } from "./types.js";

export function toExecutionStepStatus(
  status: string | undefined,
): ExecutionStep["status"] {
  if (status === "deferred" || status === "queued" || status === "progress") {
    return "deferred";
  }
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "suspended") return "suspended";
  return "completed";
}

/**
 * Builds the `UPSERT_EXECUTION_STEP` payload shared by the runtime
 * completed / failed / skipped SSE branches. The terminal status is passed in
 * (each branch resolves it differently); `detail` is included only when the
 * failure carries an error string.
 */
export function createExecutionStepUpdate(args: {
  readonly payload: Record<string, unknown>;
  readonly status: ExecutionStep["status"];
  readonly turnId: string | undefined;
}): ExecutionStep {
  const { payload, status, turnId } = args;
  return {
    runtimeId: (payload.runtimeId as string) ?? "unknown",
    pluginId: (payload.pluginId as string) ?? "",
    status,
    durationMs: payload.durationMs as number | undefined,
    turnId,
    ...(typeof payload.jobId === "string" ? { jobId: payload.jobId } : {}),
    ...(payload.mode === "detached" || status === "deferred"
      ? { detached: true }
      : {}),
    ...(typeof payload.progress === "number"
      ? { progress: payload.progress }
      : {}),
    // Match the original failed branch, which always carries the `detail` key
    // (possibly undefined). Completed / skipped branches omit it entirely.
    ...(status === "failed"
      ? { detail: payload.error as string | undefined }
      : {}),
  };
}

/** Build the explicit foreground-to-background handoff row. */
export function buildDeferredExecutionStep(
  payload: Record<string, unknown>,
  fallbackTurnId?: string,
  startedAt?: string,
): ExecutionStep | null {
  const runtimeId =
    typeof payload.runtimeId === "string" ? payload.runtimeId : "";
  if (!runtimeId) return null;
  const origin =
    payload.origin && typeof payload.origin === "object"
      ? (payload.origin as Record<string, unknown>)
      : undefined;
  return {
    runtimeId,
    pluginId: typeof payload.pluginId === "string" ? payload.pluginId : "",
    status: "deferred",
    detached: true,
    jobState: "queued",
    turnId:
      (typeof payload.originTurnId === "string"
        ? payload.originTurnId
        : undefined) ??
      (typeof payload.sourceTurnId === "string"
        ? payload.sourceTurnId
        : undefined) ??
      (typeof origin?.sourceTurnId === "string"
        ? origin.sourceTurnId
        : undefined) ??
      (typeof payload.turnId === "string" ? payload.turnId : fallbackTurnId),
    startedAt,
    ...(typeof payload.jobId === "string" ? { jobId: payload.jobId } : {}),
  };
}

/**
 * Project a kernel job-status event onto the source runtime's timeline row.
 * Mixed-version deployments may provide the source turn on the accepted event,
 * in job data, or only in the existing row, so all three are supported.
 */
export function buildJobStatusExecutionStep(
  payload: Record<string, unknown>,
  existing: ExecutionStep | undefined,
  fallbackTurnId?: string,
): ExecutionStep | null {
  const runtimeId =
    typeof payload.runtimeId === "string" ? payload.runtimeId : "";
  const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
  const state = typeof payload.state === "string" ? payload.state : "";
  if (!runtimeId || !jobId || !state) return null;

  const data =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const parentJobId =
    typeof data?.runtimeJobId === "string" ? data.runtimeJobId : undefined;
  const isRuntimeControlStatus = typeof data?.durableStatus === "string";
  const turnId =
    (typeof payload.originTurnId === "string"
      ? payload.originTurnId
      : undefined) ??
    (typeof data?.originTurnId === "string" ? data.originTurnId : undefined) ??
    existing?.turnId ??
    fallbackTurnId;
  const status: ExecutionStep["status"] =
    parentJobId && !isRuntimeControlStatus
      ? "deferred"
      : state === "succeeded"
        ? "completed"
        : state === "failed" ||
            state === "timed_out" ||
            state === "stale" ||
            state === "orphaned"
          ? "failed"
          : state === "cancelled"
            ? "skipped"
            : state === "waiting-input"
              ? "suspended"
              : "deferred";

  return {
    runtimeId,
    pluginId:
      typeof payload.pluginId === "string"
        ? payload.pluginId
        : (existing?.pluginId ?? ""),
    status,
    detached: true,
    jobId: parentJobId ?? jobId,
    jobState:
      parentJobId && !isRuntimeControlStatus
        ? (existing?.jobState ?? "running")
        : state,
    turnId,
    startedAt: existing?.startedAt,
    ...(typeof payload.progress === "number"
      ? { progress: payload.progress }
      : {}),
    ...(status === "failed"
      ? {
          detail:
            typeof data?.error === "string"
              ? data.error
              : typeof payload.error === "string"
                ? payload.error
                : typeof payload.message === "string"
                  ? payload.message
                  : undefined,
        }
      : status === "completed" || status === "skipped"
        ? { detail: undefined }
        : typeof payload.message === "string"
          ? { detail: payload.message }
          : {}),
  };
}

/** Resolve a plugin progress sub-job back to its durable runtime parent. */
export function runtimeJobCorrelationId(
  payload: Record<string, unknown>,
): string | undefined {
  const data =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  return typeof data?.runtimeJobId === "string"
    ? data.runtimeJobId
    : typeof payload.jobId === "string"
      ? payload.jobId
      : undefined;
}

/** Convert the legacy plugin-data `_jobs` row into the same timeline model. */
export function buildLegacyJobExecutionStep(
  pluginId: string,
  jobId: string,
  value: unknown,
): ExecutionStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const runtimeId = typeof row.runtimeId === "string" ? row.runtimeId : "";
  const state = typeof row.status === "string" ? row.status : "";
  if (!runtimeId || !state) return null;
  const status: ExecutionStep["status"] =
    state === "done" ? "completed" : state === "failed" ? "failed" : "deferred";
  return {
    runtimeId,
    pluginId,
    status,
    detached: true,
    jobId,
    jobState: state,
    turnId: typeof row.turnId === "string" ? row.turnId : undefined,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
    durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined,
    progress: typeof row.progress === "number" ? row.progress : undefined,
    ...(status === "failed"
      ? {
          detail:
            typeof row.error === "string"
              ? row.error
              : typeof row.abortReason === "string"
                ? row.abortReason
                : undefined,
        }
      : {}),
  };
}

/** Convert the durable staged-runtime `_runtime_jobs` record for hydration. */
export function buildDurableRuntimeJobExecutionStep(
  fallbackPluginId: string,
  jobId: string,
  value: unknown,
): ExecutionStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const runtimeId = typeof row.runtimeId === "string" ? row.runtimeId : "";
  const state = typeof row.status === "string" ? row.status : "";
  if (!runtimeId || !state) return null;
  const origin =
    row.origin && typeof row.origin === "object" && !Array.isArray(row.origin)
      ? (row.origin as Record<string, unknown>)
      : undefined;
  const failed =
    state === "failed" ||
    state === "timed_out" ||
    state === "stale" ||
    state === "orphaned";
  const status: ExecutionStep["status"] =
    state === "succeeded"
      ? "completed"
      : failed
        ? "failed"
        : state === "cancelled"
          ? "skipped"
          : "deferred";
  return {
    runtimeId,
    pluginId:
      typeof row.pluginId === "string" ? row.pluginId : fallbackPluginId,
    status,
    detached: true,
    jobId,
    jobState: state,
    turnId:
      typeof origin?.sourceTurnId === "string"
        ? origin.sourceTurnId
        : undefined,
    startedAt:
      typeof row.startedAt === "string"
        ? row.startedAt
        : typeof row.enqueuedAt === "string"
          ? row.enqueuedAt
          : undefined,
    ...(failed && typeof row.error === "string" ? { detail: row.error } : {}),
  };
}

export function buildResumedExecutionStep(
  payload: Record<string, unknown>,
  fallbackTurnId?: string,
): ExecutionStep | null {
  const runtimeId =
    typeof payload.runtimeId === "string" ? payload.runtimeId : "";
  if (!runtimeId) return null;

  return {
    runtimeId,
    pluginId: typeof payload.pluginId === "string" ? payload.pluginId : "",
    status: toExecutionStepStatus(
      typeof payload.status === "string" ? payload.status : "completed",
    ),
    turnId:
      typeof payload.turnId === "string" ? payload.turnId : fallbackTurnId,
    ...(typeof payload.durationMs === "number"
      ? { durationMs: payload.durationMs }
      : {}),
    ...(typeof payload.error === "string" ? { detail: payload.error } : {}),
  };
}
