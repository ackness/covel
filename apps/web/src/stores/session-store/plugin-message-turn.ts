import { getSourceTurnId } from "./execution-projection.js";
import type { ExecutionStep, StreamMessage } from "./types.js";

/** Compatibility for message stamps committed before retry anchors were fixed. */
export function pluginMessageTurnResolver(
  steps: readonly ExecutionStep[],
  messages: readonly StreamMessage[],
): (turnId: string) => string {
  const storyTurns = new Set(
    messages.filter((m) => m.kind === "story").map((m) => m.turnId),
  );
  const sources = new Map<string, string>();
  for (const step of steps) {
    if (
      step.turnId &&
      step.sourceTurnId &&
      step.attemptStatus === "committed" &&
      !storyTurns.has(step.turnId)
    ) {
      sources.set(step.turnId, step.sourceTurnId);
    }
  }
  return (turnId) => getSourceTurnId(turnId, sources) ?? turnId;
}
