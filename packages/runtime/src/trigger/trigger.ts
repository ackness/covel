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

  // Pre-Game completion gate: skip runtimes already marked done for the session.
  // Main-loop runtimes never enter preGameCompleted, so this is a no-op for them.
  if (context.preGameCompleted.includes(manifest.name)) {
    return false;
  }

  // startTurn — "from the N-th main-loop turn". Turn 0 (Pre-Game) is filtered
  // by the scheduler, so startTurn only meaningfully applies to turnNumber >= 1.
  if (
    trigger?.startTurn !== undefined &&
    context.turnNumber < trigger.startTurn
  ) {
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
      return context.isManualTrigger;

    case "scheduled": {
      const interval = trigger?.interval ?? 1;
      return context.turnNumber % interval === 0;
    }

    case "event":
      return (
        trigger?.topic !== undefined &&
        context.pendingEventTopics.includes(trigger.topic)
      );

    // ── RESERVED modes (never fire under the production scheduler) ──

    case "error-retry": {
      // RESERVED — `error-retry` depends on `context.hasUpstreamFailure`, but
      // the scheduling path (`turn-executor/scheduling.ts`) hardcodes
      // `hasUpstreamFailure: false`, so this branch is effectively dead in
      // production: it can only return true when a *unit test* forces the
      // flag. Warn once per (session, runtime) so authors don't ship a
      // runtime that silently never runs. The evaluation logic below is
      // retained for forward-compat and unit-testability only.
      warnReservedTrigger(context.sessionId, manifest.name, "error-retry");
      if (
        trigger?.maxRetryCount !== undefined &&
        context.triggerCount >= trigger.maxRetryCount
      ) {
        return false;
      }
      return context.hasUpstreamFailure;
    }

    case "conditional":
      // RESERVED (audit P2-9) — the schema accepts `conditional` for
      // forward-compatibility but no expression engine evaluates the
      // condition yet, so a conditional runtime stays permanently inactive.
      // Warn once per (session, runtime) so plugin authors see the silent
      // skip instead of debugging "why doesn't my plugin run".
      warnReservedTrigger(context.sessionId, manifest.name, "conditional");
      return false;

    default:
      return false;
  }
}

/**
 * Per-(session, runtime, type) warning ring so a long-running session doesn't
 * spam the log every turn for a reserved trigger mode. The size cap (256)
 * bounds memory in the unlikely case of an automated test that creates many
 * sessions; entries past the cap are simply re-warned, which is fine for a
 * soft signal.
 */
const _reservedTriggerWarned = new Set<string>();
function warnReservedTrigger(
  sessionId: string,
  runtimeId: string,
  type: "conditional" | "error-retry",
): void {
  const key = `${sessionId}:${runtimeId}:${type}`;
  if (_reservedTriggerWarned.has(key)) return;
  if (_reservedTriggerWarned.size > 256) _reservedTriggerWarned.clear();
  _reservedTriggerWarned.add(key);
  const reason =
    type === "conditional"
      ? "no condition expression engine is wired yet"
      : "the scheduler never surfaces upstream failures (hasUpstreamFailure is always false)";
  // eslint-disable-next-line no-console -- intentional dev-time warning, not user-facing
  console.warn(
    `[trigger] runtime "${runtimeId}" declares trigger.type: ${type}, ` +
      `which is reserved — ${reason}. ` +
      `The runtime will never trigger until the framework adds support. ` +
      `Use 'auto' / 'scheduled' / 'event' / 'manual' instead.`,
  );
}
