import type { ExecutionStep } from "./types.js";
import { retryStepMetadata } from "./execution-projection.js";
import { mergeReasoning } from "./reasoning.js";

const DURABLE_TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "stale",
  "orphaned",
]);
const DURABLE_ACTIVE_PHASES: Readonly<Record<string, number>> = {
  queued: 0,
  claimed: 1,
  running: 2,
  committing: 3,
};

/** Merge live/recovered rows without letting a handoff undo durable progress. */
export function mergeExecutionStep(
  previous: ExecutionStep | undefined,
  incoming: ExecutionStep,
): ExecutionStep {
  const sameJob =
    previous?.jobId !== undefined &&
    previous.jobId === incoming.jobId &&
    previous.pluginId === incoming.pluginId;
  const control = sameJob ? previous.durableJobStatus : undefined;
  let step = incoming;
  if (previous && control) {
    const nextControl = incoming.durableJobStatus;
    const older =
      nextControl?.sequence !== undefined &&
      control.sequence !== undefined &&
      nextControl.sequence <= control.sequence;
    const terminal = DURABLE_TERMINAL_STATES.has(control.state);
    const phase = DURABLE_ACTIVE_PHASES[control.state];
    const nextPhase = nextControl
      ? DURABLE_ACTIVE_PHASES[nextControl.state]
      : undefined;
    const earlierPhase =
      phase !== undefined && nextPhase !== undefined && nextPhase < phase;
    if (
      older ||
      earlierPhase ||
      (terminal &&
        (!nextControl || !DURABLE_TERMINAL_STATES.has(nextControl.state))) ||
      (!nextControl && incoming.jobState === "queued")
    ) {
      step = previous;
    } else if (!nextControl) {
      // Sub-job progress can update text/percentage, never its parent's state.
      step = {
        ...incoming,
        status: previous.status,
        jobState: previous.jobState,
      };
    } else if (nextControl.sequence === undefined) {
      // Persisted job rows have no sequence; keep the live channel's watermark.
      step = {
        ...incoming,
        durableJobStatus: {
          ...nextControl,
          ...(control.sequence !== undefined
            ? { sequence: control.sequence }
            : {}),
        },
      };
    }
  }
  const newJob =
    incoming.jobId !== undefined && previous?.jobId !== incoming.jobId;
  // One job has one start time. The handoff carries it and can arrive after a
  // control event, and control events built from a stale row omit it.
  const startedAt = sameJob
    ? (step.startedAt ?? previous?.startedAt ?? incoming.startedAt)
    : undefined;
  return {
    ...previous,
    ...(newJob
      ? {
          durableJobStatus: undefined,
          jobState: undefined,
          progress: undefined,
          detail: undefined,
        }
      : {}),
    ...step,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(previous?.reasoning || incoming.reasoning
      ? { reasoning: mergeReasoning(previous?.reasoning, incoming.reasoning) }
      : {}),
  };
}

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
    ...retryStepMetadata(payload, turnId),
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
  const retryMetadata = retryStepMetadata(payload, fallbackTurnId);
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
    ...retryMetadata,
    ...(retryMetadata.sourceTurnId && fallbackTurnId
      ? { turnId: fallbackTurnId }
      : {}),
    ...(typeof payload.jobId === "string" ? { jobId: payload.jobId } : {}),
  };
}

/**
 * Project a kernel job-status event onto the source runtime's timeline row.
 * The source turn comes from job data or the matching handoff row.
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
  const isRuntimeControlStatus =
    typeof data?.durableStatus === "string" &&
    payload.progressScopeId === jobId;
  if (existing?.jobId && existing.jobId !== (parentJobId ?? jobId)) {
    existing = undefined;
  }
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
    ...(isRuntimeControlStatus
      ? {
          durableJobStatus: {
            state: data!.durableStatus as string,
            ...(typeof payload.sequence === "number"
              ? { sequence: payload.sequence }
              : {}),
          },
        }
      : {}),
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

/** Convert a durable `_runtime_jobs` record into the timeline model. */
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
    durableJobStatus: { state },
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
