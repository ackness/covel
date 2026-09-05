import type { SessionExecutionStatus, SnapshotTraceEvent } from "@covel/shared";
import { toExecutionStepStatus } from "./execution-steps.js";
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

function stepKey(step: ExecutionStep): string {
  return `${step.turnId ?? "__no_turn__"}|${step.runtimeId}`;
}

export function buildSnapshotExecutionSteps(
  events: readonly SnapshotTraceEvent[],
): ExecutionStep[] {
  const byKey = new Map<string, ExecutionStep>();
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
        [...byKey.values()],
      );
      if (pending.length) seededAttempts.add(event.turnId);
      for (const step of pending)
        if (!byKey.has(stepKey(step))) byKey.set(stepKey(step), step);
    }
    if (!lifecycleTypes.has(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    const runtimeId =
      typeof payload.runtimeId === "string" ? payload.runtimeId : "";
    if (!runtimeId || runtimeId === "__turn__") continue;
    const turnId =
      event.type === "runtime.deferred" &&
      !byKey.get(`${event.turnId}|${runtimeId}`)?.sourceTurnId &&
      typeof payload.sourceTurnId === "string"
        ? payload.sourceTurnId
        : event.turnId;
    const key = `${turnId ?? "__no_turn__"}|${runtimeId}`;
    const prev = byKey.get(key);
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
    byKey.set(key, {
      ...prev,
      runtimeId,
      turnId,
      status,
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
      detail:
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.detail === "string"
            ? payload.detail
            : undefined,
      ...(status === "deferred"
        ? {
            detached: true,
            jobState: "queued",
            jobId:
              typeof payload.jobId === "string" ? payload.jobId : undefined,
          }
        : {}),
    });
  }
  return reconcileExecutionAttempts([...byKey.values()], events);
}

/** Browser history fills gaps; server lifecycle rows always win for matching keys. */
export function reconcileExecutionSteps(
  local: readonly ExecutionStep[],
  events: readonly SnapshotTraceEvent[],
  execution?: SessionExecutionStatus,
): ExecutionStep[] {
  const steps = new Map(local.map((step) => [stepKey(step), step]));
  for (const step of buildSnapshotExecutionSteps(events)) {
    const previous = steps.get(stepKey(step));
    steps.set(stepKey(step), {
      ...previous,
      ...step,
      ...(previous?.attemptStatus === "committed"
        ? { attemptStatus: "committed" }
        : {}),
    });
  }
  return reconcileExecutionAttempts([...steps.values()], events, execution).map(
    (step) => {
      if (
        !execution ||
        step.detached ||
        !["running", "llm", "tool"].includes(step.status)
      )
        return step;
      if (
        execution.state === "running" &&
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
    },
  );
}
