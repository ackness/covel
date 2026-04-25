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
      // Audit P2-9: `conditional` is a reserved trigger type — the schema
      // accepts it for forward-compatibility but no expression engine
      // evaluates the condition yet, so a conditional runtime stays
      // permanently inactive. Emit a one-shot console warning per
      // (sessionId, runtimeId) so plugin authors see the silent skip
      // instead of debugging "why doesn't my plugin run".
      warnConditionalReserved(context.sessionId, manifest.name);
      return false;

    default:
      return false;
  }
}

/**
 * Per-session, per-runtime warning ring so a long-running session doesn't
 * spam the log every turn. The size cap (256) bounds memory in the unlikely
 * case of an automated test that creates many sessions; entries past the
 * cap are simply re-warned, which is fine for a soft signal.
 */
const _conditionalWarned = new Set<string>();
function warnConditionalReserved(sessionId: string, runtimeId: string): void {
  const key = `${sessionId}:${runtimeId}`;
  if (_conditionalWarned.has(key)) return;
  if (_conditionalWarned.size > 256) _conditionalWarned.clear();
  _conditionalWarned.add(key);
  // eslint-disable-next-line no-console -- intentional dev-time warning, not user-facing
  console.warn(
    `[trigger] runtime "${runtimeId}" declares trigger.type: conditional, ` +
    `which is reserved — no condition expression engine is wired yet. ` +
    `The runtime will never trigger until the framework adds support. ` +
    `Use 'auto' / 'scheduled' / 'event' / 'manual' instead.`,
  );
}
