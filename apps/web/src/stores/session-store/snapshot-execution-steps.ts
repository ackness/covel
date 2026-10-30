import { appendReasoningStep, reasoningAction } from "./reasoning.js";
import {
  executionMayBeRunning,
  stageSchema,
  type SessionExecutionStatus,
  type SnapshotTraceEvent,
} from "@covel/shared";
import {
  mergeExecutionStep,
  findExecutionStepIndex,
  foldBackgroundExecutionSteps,
  toExecutionStepStatus,
  readFailureTarget,
} from "./execution-steps.js";
import {
  buildRetryAttemptSteps,
  reconcileExecutionAttempts,
} from "./execution-attempts.js";
import type { ExecutionStep } from "./types.js";

const lifecycleTypes = new Set([
  "runtime.started",
  "runtime.completed",
  "runtime.failed",
  "runtime.skipped",
  "runtime.deferred",
  "runtime.suspended",
]);

export function buildSnapshotExecutionSteps(
  events: readonly SnapshotTraceEvent[],
): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  const seededAttempts = new Set<string>();
  // Database cursors break equal timestamps with random row IDs. A start and
  // terminal event written in one millisecond must still settle as terminal.
  const order = (type: string) =>
    type === "turn.started" ? 0 : type === "runtime.started" ? 1 : 2;
  const ordered = [...events].sort(
    (first, second) =>
      first.timestamp.localeCompare(second.timestamp) ||
      order(first.type) - order(second.type),
  );
  for (const event of ordered) {
    if (event.turnId && !seededAttempts.has(event.turnId)) {
      const pending = buildRetryAttemptSteps(
        event.payload as Record<string, unknown>,
        event.turnId,
        event.timestamp,
        steps,
      );
      if (pending.length) seededAttempts.add(event.turnId);
      for (const step of pending)
        if (findExecutionStepIndex(steps, step) < 0) steps.push(step);
    }
    const reasoning = reasoningAction(
      event.type,
      event.payload as Record<string, unknown>,
      event.turnId,
      event.timestamp,
    );
    if (reasoning) {
      const index = findExecutionStepIndex(steps, reasoning);
      const step = appendReasoningStep(steps[index], reasoning);
      if (index < 0) steps.push(step);
      else steps[index] = step;
    }
    if (!lifecycleTypes.has(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    const runtimeId =
      typeof payload.runtimeId === "string" ? payload.runtimeId : "";
    if (!runtimeId || runtimeId === "__turn__") continue;
    const turnId =
      event.type === "runtime.deferred" &&
      !steps[findExecutionStepIndex(steps, { turnId: event.turnId, runtimeId })]
        ?.sourceTurnId &&
      typeof payload.sourceTurnId === "string"
        ? payload.sourceTurnId
        : event.turnId;
    const runId =
      typeof payload.runId === "string" &&
      payload.runId &&
      [
        "runtime.started",
        "runtime.completed",
        "runtime.failed",
        "runtime.skipped",
      ].includes(event.type)
        ? payload.runId
        : undefined;
    const index = findExecutionStepIndex(steps, { turnId, runtimeId, runId });
    const prev = steps[index];
    const stage = stageSchema.safeParse(payload.stage);
    const status =
      event.type === "runtime.completed"
        ? toExecutionStepStatus(
            typeof payload.status === "string" ? payload.status : undefined,
          )
        : event.type === "runtime.started"
          ? "running"
          : event.type === "runtime.failed"
            ? "failed"
            : event.type === "runtime.skipped"
              ? "skipped"
              : event.type === "runtime.suspended"
                ? "suspended"
                : "deferred";
    const step: ExecutionStep = {
      ...prev,
      ...(stage.success ? { stage: stage.data } : {}),
      runtimeId,
      ...(runId ? { runId } : {}),
      turnId,
      status,
      errorKind:
        status === "failed" && typeof payload.errorKind === "string"
          ? payload.errorKind
          : undefined,
      failureTarget:
        status === "failed"
          ? readFailureTarget(payload.failureTarget)
          : undefined,
      pluginId:
        typeof payload.pluginId === "string"
          ? payload.pluginId
          : (prev?.pluginId ?? ""),
      label: typeof payload.label === "string" ? payload.label : prev?.label,
      durationMs:
        typeof payload.durationMs === "number"
          ? payload.durationMs
          : prev?.durationMs,
      startedAt:
        event.type === "runtime.started" ? event.timestamp : prev?.startedAt,
      // A skipped runtime's reason code, as the live stream gives it.
      detail:
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.detail === "string"
            ? payload.detail
            : status === "skipped" && typeof payload.reason === "string"
              ? payload.reason
              : undefined,
      ...(status === "deferred"
        ? {
            detached: true,
            jobState: "queued",
            jobId:
              typeof payload.jobId === "string" ? payload.jobId : undefined,
          }
        : {}),
    };
    if (index < 0) steps.push(step);
    else steps[index] = step;
  }
  return reconcileExecutionAttempts(steps, events);
}

/** Browser history fills gaps; server lifecycle rows always win for matching keys. */
export function reconcileExecutionSteps(
  local: readonly ExecutionStep[],
  events: readonly SnapshotTraceEvent[],
  execution?: SessionExecutionStatus,
): ExecutionStep[] {
  const steps = [...local];
  for (const step of buildSnapshotExecutionSteps(events)) {
    const index = findExecutionStepIndex(steps, step);
    const previous = steps[index];
    const merged: ExecutionStep = {
      ...mergeExecutionStep(previous, step),
      ...(step.status === "llm" && previous ? { status: previous.status } : {}),
      ...(previous?.attemptStatus === "committed"
        ? { attemptStatus: "committed" }
        : {}),
    };
    if (index < 0) steps.push(merged);
    else steps[index] = merged;
  }
  return reconcileExecutionAttempts(
    foldBackgroundExecutionSteps(steps),
    events,
    execution,
  ).map((step) => {
    if (
      !execution ||
      step.detached ||
      !["running", "llm", "tool"].includes(step.status)
    )
      return step;
    if (
      executionMayBeRunning(execution) &&
      (!execution.turnId || step.turnId === execution.turnId)
    )
      return step;
    return {
      ...step,
      status: "failed",
      detail:
        step.sourceTurnId && step.attemptStatus === "committed"
          ? "__i18n:session.reasonRetryNotCompleted__"
          : "__i18n:session.reasonInterrupted__",
    };
  });
}
