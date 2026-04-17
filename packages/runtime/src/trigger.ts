/**
 * Trigger Router — decides whether a runtime should execute in the current turn.
 * Band filtering (Pre-Game vs main loop) happens in the scheduler. This layer
 * only evaluates per-runtime semantics.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { TriggerContext } from './types.js';

export function shouldTrigger(
  manifest: RuntimeManifest,
  context: TriggerContext,
): boolean {
  const trigger = manifest.trigger;
  const type = trigger?.type ?? 'auto';

  // Pre-Game completion gate: skip runtimes already marked done for the session.
  // Main-loop runtimes never enter preGameCompleted, so this is a no-op for them.
  if (context.preGameCompleted.includes(manifest.name)) {
    return false;
  }

  // startTurn — "from the N-th main-loop turn". Turn 0 (Pre-Game) is filtered
  // by the scheduler, so startTurn only meaningfully applies to turnNumber >= 1.
  if (trigger?.startTurn !== undefined && context.turnNumber < trigger.startTurn) {
    return false;
  }

  if (trigger?.maxTriggerCount !== undefined && context.triggerCount >= trigger.maxTriggerCount) {
    return false;
  }

  if (trigger?.cooldownTurns !== undefined && context.turnsSinceLastTrigger < trigger.cooldownTurns) {
    return false;
  }

  switch (type) {
    case 'auto':
      return true;

    case 'manual':
      return context.isManualTrigger;

    case 'scheduled': {
      const interval = trigger?.interval ?? 1;
      return context.turnNumber % interval === 0;
    }

    case 'event':
      return trigger?.topic !== undefined && context.pendingEventTopics.includes(trigger.topic);

    case 'error-retry': {
      if (trigger?.maxRetryCount !== undefined && context.triggerCount >= trigger.maxRetryCount) {
        return false;
      }
      return context.hasUpstreamFailure;
    }

    case 'conditional':
      return false;

    default:
      return false;
  }
}
