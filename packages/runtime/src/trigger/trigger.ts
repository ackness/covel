/**
 * Trigger Router — decides whether a runtime should execute in the current turn.
 * Band filtering (Pre-Game vs main loop) happens in the scheduler. This layer
 * only evaluates per-runtime semantics.
 */

import type { RuntimeManifest } from "@covel/shared";
import type { TriggerContext } from "../types.js";

export function shouldTrigger(
  manifest: RuntimeManifest,
  context: TriggerContext,
): boolean {
  const trigger = manifest.trigger;
  const type = trigger?.type ?? "auto";
  const logicalTurn = context.logicalTurn;

  // startTurn — "from the N-th main-loop logical turn". Gated on `logicalTurn`
  // (completed player turns + 1), which counts only committed main-loop turns,
  // so setup interactions no longer inflate the effective turn number.
  if (trigger?.startTurn !== undefined && logicalTurn < trigger.startTurn) {
    return false;
  }

  if (
    trigger?.maxTriggerCount !== undefined &&
    context.triggerCount >= trigger.maxTriggerCount
  ) {
    return false;
  }

  if (
    trigger?.cooldownTurns !== undefined &&
    context.turnsSinceLastTrigger < trigger.cooldownTurns
  ) {
    return false;
  }

  switch (type) {
    case "auto":
      // Read the logical-turn number N (= completedPlayerTurns + 1), not the
      // raw player-message count. `every: 2` fires on logical turns 2, 4,
      // 6 — setup interactions never shift the cadence (scenario 13).
      return logicalTurn % (trigger?.every ?? 1) === 0;

    case "manual":
      // Explicit manual selection bypasses this router.
      return false;

    case "event":
      return (
        trigger?.topic !== undefined &&
        context.pendingEventTopics.includes(trigger.topic)
      );

    default:
      return false;
  }
}
