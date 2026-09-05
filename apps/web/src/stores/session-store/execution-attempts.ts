import type { SessionExecutionStatus, SnapshotTraceEvent } from "@covel/shared";
import { getSourceTurnId, retryStepMetadata } from "./execution-projection.js";
import type { ExecutionStep } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function recoverySource(
  payload: Record<string, unknown>,
): string | undefined {
  if (
    typeof payload.sourceTurnId === "string" &&
    Array.isArray(payload.runtimeIds) &&
    payload.runtimeIds.length > 0
  )
    return payload.sourceTurnId;
  const action = asRecord(payload.recoveryAction);
  if (
    action?.type !== "retry_runtime" &&
    action?.type !== "retry_failed_runtimes"
  )
    return undefined;
  const actionPayload = asRecord(action.payload);
  return typeof actionPayload?.retryFromTurnId === "string"
    ? actionPayload.retryFromTurnId
    : undefined;
}

/** Selected retry tasks are already pending while the turn prepares its input. */
export function buildRetryAttemptSteps(
  payload: Record<string, unknown>,
  turnId: string | undefined,
  startedAt: string,
  existing: readonly ExecutionStep[],
): ExecutionStep[] {
  const sourceTurnId = recoverySource(payload);
  if (!sourceTurnId || !turnId || sourceTurnId === turnId) return [];
  const actionPayload = asRecord(asRecord(payload.recoveryAction)?.payload);
  const rawIds =
    payload.runtimeIds ??
    actionPayload?.runtimeIds ??
    (typeof actionPayload?.runtimeId === "string"
      ? [actionPayload.runtimeId]
      : []);
  if (!Array.isArray(rawIds)) return [];
  const runtimeIds = [
    ...new Set(
      rawIds.filter((id): id is string => typeof id === "string" && !!id),
    ),
  ];
  return runtimeIds.map((runtimeId) => {
    const previous = existing.findLast(
      (step) =>
        step.runtimeId === runtimeId &&
        (step.turnId === sourceTurnId || step.sourceTurnId === sourceTurnId),
    );
    return {
      ...retryStepMetadata(payload, turnId),
      runtimeId,
      pluginId: previous?.pluginId ?? "",
      label: previous?.label,
      turnId,
      sourceTurnId,
      status: "running",
      attemptStatus: "pending",
      startedAt,
      turnStartedAt: startedAt,
    };
  });
}

/** Attach source/commit evidence without changing the actual attempt identity. */
export function reconcileExecutionAttempts(
  steps: readonly ExecutionStep[],
  events: readonly SnapshotTraceEvent[],
  execution?: SessionExecutionStatus,
): ExecutionStep[] {
  const sources = new Map<string, string>();
  const started = new Map<string, string>();
  const terminal = new Map<string, ExecutionStep["attemptStatus"]>();
  const scopeMetadata = new Map<string, Partial<ExecutionStep>>();
  const scopePriority = new Map<string, number>();
  for (const step of steps) {
    if (step.turnId && step.sourceTurnId)
      sources.set(step.turnId, step.sourceTurnId);
  }
  for (const event of events) {
    if (!event.turnId) continue;
    const payload = asRecord(event.payload) ?? {};
    // Detached jobs use sourceTurnId for their handoff, not a retry relation.
    const source =
      event.type === "runtime.deferred" ? undefined : recoverySource(payload);
    if (source && source !== event.turnId) sources.set(event.turnId, source);
    const priority =
      event.type === "turn.completed" && payload.committed === true
        ? 2
        : event.type === "turn.started"
          ? 0
          : 1;
    if (
      source &&
      source !== event.turnId &&
      priority >= (scopePriority.get(event.turnId) ?? -1)
    ) {
      scopeMetadata.set(event.turnId, {
        ...scopeMetadata.get(event.turnId),
        ...retryStepMetadata(payload, event.turnId),
      });
      scopePriority.set(event.turnId, priority);
    }
    if (event.type === "turn.started")
      started.set(event.turnId, event.timestamp);
    if (
      event.type === "turn.completed" &&
      typeof payload.committed === "boolean" &&
      terminal.get(event.turnId) !== "committed"
    )
      terminal.set(
        event.turnId,
        payload.committed === true ? "committed" : "failed",
      );
    if (
      event.type === "turn.failed" &&
      terminal.get(event.turnId) !== "committed"
    )
      terminal.set(event.turnId, "failed");
  }
  return steps.map((step) => {
    if (!step.turnId) return step;
    const sourceTurnId = getSourceTurnId(step.turnId, sources);
    const turnStartedAt =
      (step.turnId && started.get(step.turnId)) || step.turnStartedAt;
    let attemptStatus =
      (step.attemptStatus === "committed"
        ? "committed"
        : terminal.get(step.turnId)) ??
      step.attemptStatus ??
      (started.has(step.turnId) || sourceTurnId !== step.turnId
        ? "pending"
        : undefined);
    if (execution && execution.turnId === step.turnId) {
      if (execution.state === "completed") attemptStatus = "committed";
      else if (attemptStatus !== "committed" && !terminal.has(step.turnId)) {
        if (execution.state === "failed") attemptStatus = "failed";
        else if (execution.state === "interrupted")
          attemptStatus = "interrupted";
        else if (execution.state === "running") attemptStatus = "pending";
      }
    }
    if (
      attemptStatus === "pending" &&
      execution &&
      !(
        execution.state === "running" &&
        (!execution.turnId || step.turnId === execution.turnId)
      )
    )
      attemptStatus = "interrupted";
    return {
      ...step,
      ...scopeMetadata.get(step.turnId),
      ...(sourceTurnId !== step.turnId ? { sourceTurnId } : {}),
      ...(turnStartedAt ? { turnStartedAt } : {}),
      ...(attemptStatus ? { attemptStatus } : {}),
    };
  });
}

/** Reducer-owned settlement remains correct for consecutive SSE events in one render. */
export function settleExecutionAttempt(
  steps: readonly ExecutionStep[],
  turnId: string,
  status: NonNullable<ExecutionStep["attemptStatus"]>,
  sourceFailedRuntimeIds?: readonly string[],
): ExecutionStep[] {
  return steps.map((step) =>
    step.turnId === turnId
      ? {
          ...step,
          attemptStatus:
            step.attemptStatus === "committed" ? "committed" : status,
          ...(step.sourceTurnId && sourceFailedRuntimeIds
            ? { sourceCommitted: true, sourceFailedRuntimeIds }
            : {}),
        }
      : step,
  );
}
