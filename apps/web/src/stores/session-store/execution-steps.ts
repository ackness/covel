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
    // Match the original failed branch, which always carries the `detail` key
    // (possibly undefined). Completed / skipped branches omit it entirely.
    ...(status === "failed"
      ? { detail: payload.error as string | undefined }
      : {}),
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
