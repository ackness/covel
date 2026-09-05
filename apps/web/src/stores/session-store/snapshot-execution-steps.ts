import type { SessionExecutionStatus, SnapshotTraceEvent } from "@covel/shared";
import { toExecutionStepStatus } from "./execution-steps.js";
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
  // Database cursors break equal timestamps with random row IDs. A start and
  // terminal event written in one millisecond must still settle as terminal.
  const ordered = [...events].sort(
    (first, second) =>
      first.timestamp.localeCompare(second.timestamp) ||
      Number(first.type !== "runtime.started") -
        Number(second.type !== "runtime.started"),
  );
  for (const event of ordered) {
    if (!lifecycleTypes.has(event.type)) continue;
    const payload = event.payload as Record<string, unknown>;
    const runtimeId =
      typeof payload.runtimeId === "string" ? payload.runtimeId : "";
    if (!runtimeId || runtimeId === "__turn__") continue;
    const turnId =
      event.type === "runtime.deferred" &&
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
  return [...byKey.values()];
}

/** Browser history fills gaps; server lifecycle rows always win for matching keys. */
export function reconcileExecutionSteps(
  local: readonly ExecutionStep[],
  events: readonly SnapshotTraceEvent[],
  execution?: SessionExecutionStatus,
): ExecutionStep[] {
  const steps = new Map(local.map((step) => [stepKey(step), step]));
  for (const step of buildSnapshotExecutionSteps(events))
    steps.set(stepKey(step), step);
  return [...steps.values()].map((step) => {
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
      detail: "__i18n:session.reasonInterrupted__",
    };
  });
}
