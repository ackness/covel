import type { ExecutionContext, TurnInput } from "@covel/shared";

/**
 * Create an execution identity before session state is loaded. Early hook
 * aborts carry this conservative non-counting context.
 */
export function createExecutionContext(input: TurnInput): ExecutionContext {
  return {
    executionId: crypto.randomUUID(),
    origin: input.origin,
    countPolicy: "none",
    ...(input.logicalTurnId ? { logicalTurnId: input.logicalTurnId } : {}),
  };
}

/**
 * Fix counting responsibility from the authoritative persisted phase while
 * preserving the identity allocated at execution entry.
 */
export function applySessionPhaseCountPolicy(
  context: ExecutionContext,
  phase: "setup" | "playing",
): ExecutionContext {
  const countPolicy =
    context.origin === "player" && phase === "playing"
      ? "complete-player-turn"
      : "none";
  return context.countPolicy === countPolicy
    ? context
    : { ...context, countPolicy };
}
