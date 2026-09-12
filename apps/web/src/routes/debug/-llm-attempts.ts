import type { TraceEvent } from "@/services/api.js";
import {
  getDisplayType,
  getTraceData,
  getTraceError,
  traceEventIdentity,
} from "./-debug-helpers.js";

export interface LlmAttempt {
  calling: TraceEvent;
  response?: TraceEvent;
  call: number;
  attempt: number;
  status: "pending" | "succeeded" | "failed" | "recovered";
}

/** Pair within one runtime/turn; attempt numbers restart for each tool-loop step. */
export function llmAttempts(
  event: TraceEvent,
  related: readonly TraceEvent[],
): LlmAttempt[] {
  const runtimeId =
    event.diagnostic?.runtimeId ?? getTraceData(event.payload).runtimeId;
  if (!runtimeId) return [];
  const seen = new Set<string>();
  const events = [event, ...related]
    .filter((candidate) => {
      const identity = traceEventIdentity(candidate);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return (
        candidate.turnId === event.turnId &&
        (candidate.diagnostic?.runtimeId ??
          getTraceData(candidate.payload).runtimeId) === runtimeId
      );
    })
    .sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
  const result: LlmAttempt[] = [];
  let call = 0;
  for (const candidate of events) {
    const type = getDisplayType(candidate);
    const data = getTraceData(candidate.payload);
    if (type === "llm.calling") {
      const attempt = typeof data.attempt === "number" ? data.attempt : 0;
      if (attempt === 0 || !call) call++;
      result.push({ calling: candidate, call, attempt, status: "pending" });
    } else if (type === "llm.responded") {
      const pending = result.findLast(
        (item) => !item.response && item.attempt === (data.attempt ?? 0),
      );
      if (!pending) continue;
      pending.response = candidate;
      pending.status = getTraceError(candidate) ? "failed" : "succeeded";
      if (pending.status === "succeeded") {
        for (const previous of result) {
          if (previous.call === pending.call && previous.status === "failed")
            previous.status = "recovered";
        }
      }
    }
  }
  return result;
}
