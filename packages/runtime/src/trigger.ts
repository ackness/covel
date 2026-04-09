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

  // Global limits: maxTriggerCount
  if (trigger?.maxTriggerCount !== undefined && context.triggerCount >= trigger.maxTriggerCount) {
    return false;
  }

  // Global limits: cooldownTurns
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
      // Only known conditions are supported; return false for all conditions for now.
      return false;

    default:
      return false;
  }
}
