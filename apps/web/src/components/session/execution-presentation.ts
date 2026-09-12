import {
  PLAYER_ABORT_REASON,
  type SessionExecutionStatus,
} from "@covel/shared";
import type { ExecutionStep, StreamMessage } from "@/stores/session-store.js";
import { projectExecutionTurns } from "@/stores/session-store/execution-projection.js";

export type ExecutionPresentation =
  | "idle"
  | "generating"
  | "updating"
  | "stopped"
  | "partial"
  | "failed"
  | "interrupted"
  | "completed";

/** One interpretation of foreground execution for the header, composer and turn card. */
export function executionPresentation({
  executing,
  steps,
  messages = [],
  recovery,
}: {
  executing: boolean;
  steps: readonly ExecutionStep[];
  messages?: readonly StreamMessage[];
  recovery?: SessionExecutionStatus | null;
}): ExecutionPresentation {
  const foreground = steps.filter((step) => !step.detached);
  if (executing || recovery?.state === "running") {
    const storyReady = messages.some(
      (message) =>
        message.role === "assistant" &&
        !message.block &&
        (!message.kind || message.kind === "story") &&
        ((!message.id.startsWith("stream_") && !!message.content) ||
          (message.runtimeId !== undefined &&
            foreground.some(
              (step) =>
                step.runtimeId === message.runtimeId &&
                step.status === "completed",
            ))),
    );
    return storyReady ? "updating" : "generating";
  }
  if (
    recovery?.abortReason === PLAYER_ABORT_REASON ||
    foreground.some((step) => step.abortReason === PLAYER_ABORT_REASON)
  )
    return "stopped";
  if (
    recovery?.state === "interrupted" ||
    foreground.some((step) => step.attemptStatus === "interrupted")
  )
    return "interrupted";
  if (
    recovery?.state === "failed" ||
    foreground.some((step) => step.attemptStatus === "failed")
  )
    return "failed";
  if (foreground.some((step) => step.status === "failed"))
    return foreground.some((step) => step.attemptStatus === "committed")
      ? "partial"
      : "failed";
  return foreground.length || recovery?.state === "completed"
    ? "completed"
    : "idle";
}

export function executionTone(state: ExecutionPresentation): string {
  if (state === "failed") return "text-destructive";
  if (["stopped", "partial", "interrupted"].includes(state))
    return "text-amber-600 dark:text-amber-400";
  if (["generating", "updating"].includes(state)) return "text-primary";
  return "text-muted-foreground";
}

export function latestExecutionPresentation(input: {
  executing: boolean;
  executionSteps: readonly ExecutionStep[];
  messages: readonly StreamMessage[];
  executionRecovery?: { status: SessionExecutionStatus | null } | null;
}): ExecutionPresentation {
  const latest = projectExecutionTurns(
    input.messages,
    input.executionSteps,
  ).latestTurn;
  const pending =
    input.executing &&
    input.messages.at(-1)?.role === "user" &&
    !input.messages.at(-1)?.turnId;
  return executionPresentation({
    executing: input.executing,
    steps: pending ? [] : (latest?.steps ?? []),
    messages: pending
      ? []
      : (latest?.messages.map((entry) => entry.message) ?? []),
    recovery: input.executionRecovery?.status,
  });
}
