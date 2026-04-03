import { randomUUID } from "node:crypto";
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
 * - "interval": included only when turnNumber % intervalTurns === 0
 */
export function routeTrigger(
  input: KernelInput,
  allRuntimes: RegisteredRuntime[],
  turnNumber?: number
): { triggerEvent: RuntimeTriggerEvent; candidates: CandidateRuntime[] } {
  const triggerEvent: RuntimeTriggerEvent = {
    eventId: `evt-${randomUUID()}`,
    type: input.type,
    source: input.actorId,
    payload: input.payload,
    timestamp: new Date().toISOString(),
  };

  const candidates: CandidateRuntime[] = [];
  const seen = new Set<string>();

  for (const registered of allRuntimes) {
    const runtimeKey = `${registered.pluginId}:${registered.spec.id}`;
    if (seen.has(runtimeKey)) continue;

    const trigger = registered.spec.trigger;

    switch (trigger.mode) {
      case "always":
        seen.add(runtimeKey);
        candidates.push({ registered, triggerEvent });
        break;

      case "event":
        if (trigger.onEvents?.includes(input.type)) {
          seen.add(runtimeKey);
          candidates.push({ registered, triggerEvent });
        }
        break;

      case "manual":
        // Only include if the input specifically targets this runtime
        if (input.type === "system.event" && input.payload?.targetRuntimeId) {
          const qid = `${registered.pluginId}:${registered.spec.id}`;
          if (input.payload.targetRuntimeId === qid) {
            seen.add(runtimeKey);
            candidates.push({ registered, triggerEvent });
          }
        }
        break;

      case "interval": {
        const interval = trigger.intervalTurns ?? 1;
        // When turnNumber is available, only include if it aligns with the interval.
        // turnNumber undefined (legacy callers) => always include for backward compat.
        if (turnNumber == null || interval <= 1 || turnNumber % interval === 0) {
          seen.add(runtimeKey);
          candidates.push({ registered, triggerEvent });
        }
        break;
      }
    }
  }

  return { triggerEvent, candidates };
}
