import type { KernelInput, RuntimeTriggerEvent } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";
import type { CandidateRuntime } from "../types.js";

/**
 * Convert KernelInput into a trigger event and select candidate runtimes.
 *
 * Filtering logic per runtime trigger.mode:
 * - "always": always included
 * - "event": included if trigger.onEvents matches the event type
 * - "manual": only on explicit manual_action
 * - "interval": always included (interval counting is scheduler's job)
 */
export function routeTrigger(
  input: KernelInput,
  allRuntimes: RegisteredRuntime[]
): { triggerEvent: RuntimeTriggerEvent; candidates: CandidateRuntime[] } {
  const triggerEvent: RuntimeTriggerEvent = {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    source: input.actorId,
    payload: input.payload,
    timestamp: new Date().toISOString(),
  };

  const candidates: CandidateRuntime[] = [];

  for (const registered of allRuntimes) {
    const trigger = registered.spec.trigger;

    switch (trigger.mode) {
      case "always":
        candidates.push({ registered, triggerEvent });
        break;

      case "event":
        if (trigger.onEvents?.includes(input.type)) {
          candidates.push({ registered, triggerEvent });
        }
        break;

      case "manual":
        // Only include if the input specifically targets this runtime
        if (input.type === "system.event" && input.payload?.targetRuntimeId) {
          const qid = `${registered.pluginId}:${registered.spec.id}`;
          if (input.payload.targetRuntimeId === qid) {
            candidates.push({ registered, triggerEvent });
          }
        }
        break;

      case "interval":
        // Always include; actual interval gating is the scheduler's responsibility
        candidates.push({ registered, triggerEvent });
        break;
    }
  }

  return { triggerEvent, candidates };
}
