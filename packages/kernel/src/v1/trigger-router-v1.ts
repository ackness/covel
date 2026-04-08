import type { LoadedRuntime } from "@covel/plugin-manager";
import type { V1TriggerInput, V1Candidate, V1SessionState } from "./types.js";

const PRE_GAME_BOUNDARY = 100;

/**
 * V1 Trigger Router.
 *
 * Routes a trigger input to candidate runtimes based on:
 * - Trigger type matching (pre-game-once, turn, event, manual, approval-callback)
 * - Pre-game boundary (priority < 100 only in turn0)
 * - Run limits (maxRunsPerSession, maxRunsPerTurn)
 * - Pre-game-once dedup
 */
export function routeTriggerV1(
  input: V1TriggerInput,
  allRuntimes: LoadedRuntime[],
  sessionState: V1SessionState,
): V1Candidate[] {
  const candidates: V1Candidate[] = [];

  for (const runtime of allRuntimes) {
    const trigger = runtime.manifest.trigger;
    const priority = runtime.manifest.priority;
    const qid = `${runtime.pluginId}:${runtime.manifest.id}`;

    // Pre-game boundary: priority < 100 only runs in pre-game (turn0)
    if (priority < PRE_GAME_BOUNDARY && !sessionState.isPreGame) continue;
    // Normal turn runtimes don't run during pre-game
    if (priority >= PRE_GAME_BOUNDARY && sessionState.isPreGame && input.type !== "manual") continue;

    // Check run limits
    const counts = sessionState.runCounts.get(qid) ?? { session: 0, turn: 0 };
    const limits = runtime.manifest.limits;
    if (limits?.maxRunsPerSession != null && counts.session >= limits.maxRunsPerSession) continue;
    if (limits?.maxRunsPerTurn != null && counts.turn >= limits.maxRunsPerTurn) continue;

    // Match trigger type
    switch (trigger.type) {
      case "pre-game-once": {
        if (input.type !== "pre-game") continue;
        // Dedup: only run once per session
        if (sessionState.preGameCompleted.has(qid)) continue;
        candidates.push({ runtime, triggerInput: input });
        break;
      }

      case "turn": {
        if (input.type !== "turn") continue;
        candidates.push({ runtime, triggerInput: input });
        break;
      }

      case "event": {
        if (input.type !== "event") continue;
        // Match event type against runtime's declared events
        if (trigger.events && input.eventType) {
          if (trigger.events.includes(input.eventType)) {
            candidates.push({ runtime, triggerInput: input });
          }
        }
        break;
      }

      case "manual": {
        if (input.type !== "manual") continue;
        // Match action ID
        if (trigger.action && input.actionId === trigger.action) {
          candidates.push({ runtime, triggerInput: input });
        }
        break;
      }

      case "approval-callback": {
        if (input.type !== "approval-callback") continue;
        candidates.push({ runtime, triggerInput: input });
        break;
      }
    }
  }

  return candidates;
}
