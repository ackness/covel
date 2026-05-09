import type { ExecutionStep } from "./types.js";

export function toExecutionStepStatus(
  status: string | undefined,
): ExecutionStep["status"] {
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "suspended") return "suspended";
  return "completed";
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
