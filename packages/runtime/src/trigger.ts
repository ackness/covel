/**
 * Trigger Router — decides whether a runtime should execute in the current turn.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { TriggerContext } from './types.js';

/**
 * Evaluate whether a runtime should trigger in this turn.
 *
 * Trigger types:
 * - auto: always triggers
 * - manual: only when isManualTrigger is true
 * - scheduled: every N turns (interval)
 * - conditional: evaluates a condition string
 * - event: when a matching event topic is pending
 * - error-retry: when an upstream has failed
 *
 * Also checks global limits:
 * - maxTriggerCount: session-wide max
 * - cooldownTurns: min gap between triggers
 */
export function shouldTrigger(
  manifest: RuntimeManifest,
  context: TriggerContext,
): boolean {
  const trigger = manifest.trigger;
  const type = trigger?.type ?? 'auto';

  // Global limits: startTurn — runtime stays silent before this turn.
  // Compared against `playingTurnNumber` (rounds since session entered
  // playing phase), not the global `turnNumber`. This matches the plugin
  // author's intuition of "from the N-th round of actual gameplay",
  // decoupling the startTurn semantics from pre-game / char-creation
  // activity. Only applied when explicitly declared.
  if (trigger?.startTurn !== undefined && context.playingTurnNumber < trigger.startTurn) {
    return false;
  }

  // Global limits: maxTriggerCount
  if (trigger?.maxTriggerCount !== undefined && context.triggerCount >= trigger.maxTriggerCount) {
    return false;
  }

  // Global limits: cooldownTurns
  if (trigger?.cooldownTurns !== undefined && context.turnsSinceLastTrigger < trigger.cooldownTurns) {
    return false;
  }

  // Phase gate: skip if current session phase is not in the allowed list
  if (trigger?.phases && trigger.phases.length > 0 && context.sessionPhase) {
    if (!trigger.phases.includes(context.sessionPhase)) {
      return false;
    }
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
      // Only known conditions are supported; return false for all conditions for now.
      return false;

    default:
      return false;
  }
}
