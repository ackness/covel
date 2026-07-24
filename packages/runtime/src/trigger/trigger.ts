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
  // Logical-turn number N (= completedPlayerTurns + 1). Production selection
  // always supplies it; fall back to the raw player-message count when a caller
  // omits it (legacy test builders) so behaviour degrades to the old reading.
  const logicalTurn = context.logicalTurn ?? context.turnNumber;

  // Pre-Game completion gate: skip runtimes already marked done for the session.
  // Main-loop runtimes never enter preGameCompleted, so this is a no-op for them.
  if (context.preGameCompleted.includes(manifest.name)) {
    return false;
  }

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
      return true;

    case "manual":
      // Dead in the production selection path: selectTriggeredRuntimes picks
      // manual runtimes by name match and never calls shouldTrigger for them
      // (an explicit plugin-rpc call IS the trigger decision). Kept for direct
      // callers (tests, event fan-out reuse) — see CLAUDE.md "Trigger modes".
      return context.isManualTrigger;

    case "scheduled": {
      // Read the logical-turn number N (= completedPlayerTurns + 1), not the
      // raw player-message count. `interval: 2` fires on logical turns 2, 4,
      // 6 — setup interactions never shift the cadence (scenario 13).
      const interval = trigger?.interval ?? 1;
      return logicalTurn % interval === 0;
    }

    case "event":
      return (
        trigger?.topic !== undefined &&
        context.pendingEventTopics.includes(trigger.topic)
      );

    default:
      return false;
  }
}
