import type { ExecutionStep } from "./types.js";

const TERMINAL = new Set<ExecutionStep["status"]>([
  "completed",
  "failed",
  "skipped",
  "suspended",
]);
const REJECTIONS = new Set([
  "invalid-json",
  "invalid-output",
  "missing-submission",
  "required-work",
  "review-rejected",
  "submission-batch",
  "superseded",
]);

export interface ExecutionProgress {
  type: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
  runId?: string;
  modelStep?: number;
  toolName?: string;
  rejected: boolean;
}

/** Model/tool activity describes work, never story text or reviewer feedback. */
export function readExecutionProgress(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  turnId: string | undefined,
): ExecutionProgress | undefined {
  if (
    !turnId ||
    typeof payload.runtimeId !== "string" ||
    typeof payload.pluginId !== "string"
  )
    return;
  const modelStep =
    typeof payload.step === "number" &&
    Number.isSafeInteger(payload.step) &&
    payload.step > 0
      ? payload.step
      : undefined;
  const rejected =
    type === "step.completed" &&
    Array.isArray(payload.notes) &&
    payload.notes.some((note: unknown) => {
      if (!note || typeof note !== "object") return false;
      const value = note as Record<string, unknown>;
      return (
        value.kind === "output-rejected" &&
        typeof value.reason === "string" &&
        REJECTIONS.has(value.reason) &&
        Number.isSafeInteger(value.attempt) &&
        Number(value.attempt) > 0
      );
    });
  return {
    type,
    turnId,
    runtimeId: payload.runtimeId,
    pluginId: payload.pluginId,
    ...(typeof payload.runId === "string" && payload.runId
      ? { runId: payload.runId }
      : {}),
    ...(modelStep !== undefined ? { modelStep } : {}),
    ...(type === "tool.calling" && typeof payload.toolName === "string"
      ? { toolName: payload.toolName }
      : {}),
    rejected,
  };
}

/** Merge against reducer state so a single network batch retains every transition. */
export function executionProgressStep(
  progress: ExecutionProgress,
  steps: readonly ExecutionStep[],
): ExecutionStep | undefined {
  const { type, turnId, runId, modelStep, rejected } = progress;
  const candidates = steps.filter(
    (step) =>
      step.turnId === turnId &&
      step.runtimeId === progress.runtimeId &&
      step.pluginId === progress.pluginId,
  );
  const previous = runId
    ? candidates.find((step) => step.runId === runId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if ((!runId && !previous) || (previous && TERMINAL.has(previous.status)))
    return;
  if (
    modelStep !== undefined &&
    previous?.modelStep !== undefined &&
    modelStep < previous.modelStep
  )
    return;
  return {
    ...previous,
    runtimeId: progress.runtimeId,
    pluginId: progress.pluginId,
    turnId,
    ...(runId ? { runId } : {}),
    ...(modelStep !== undefined ? { modelStep } : {}),
    status:
      type === "tool.calling"
        ? "tool"
        : type === "llm.calling"
          ? "llm"
          : "running",
    revising:
      rejected || (previous?.revising === true && type !== "step.completed"),
    toolName: progress.toolName,
  };
}
