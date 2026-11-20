import type * as api from "@/services/api.js";
import {
  categorize,
  traceEventIdentity,
  type EventCategory,
} from "./-debug-helpers.js";

export type DebugView = "traces" | "data" | "cost" | "plugins";

export interface VisibleTurn {
  turn: api.TurnTrace;
  turnIndex: number;
}

function isManualTurn(turn: api.TurnTrace): boolean {
  return turn.events.some(
    (event) =>
      event.type === "turn.started" &&
      event.payload &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).manualTrigger,
  );
}

export function getVisibleTurns(turns: api.TurnTrace[]): VisibleTurn[] {
  let storyIndex = 0;
  return turns.map((turn) => {
    if (!isManualTurn(turn)) storyIndex++;
    return { turn, turnIndex: storyIndex };
  });
}

export function traceEventMatchesCategory(
  event: api.TraceEvent,
  category: EventCategory | null,
): boolean {
  return (
    category === null ||
    categorize(event.type) === category ||
    categorize((event.payload.type as string) || event.type) === category
  );
}

/**
 * Deduplication key for trace events: paging across windows or refreshing the
 * latest window can surface the same event again, so include `seq` alongside
 * requestId, traceId, type, and timestamp.
 */
function traceEventKey(event: api.TraceEvent): string {
  return traceEventIdentity(event);
}

/** Return the earlier non-empty timestamp (treating `""` as missing). */
function earlierTimestamp(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Return the later non-empty timestamp (treating `""` as missing). */
function laterTimestamp(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Merge two batches of turns by `turnId`. Because pagination splits by event
 * rather than turn boundaries, loading an older page or refreshing the latest
 * window merges events with the same `turnId`, deduplicates, recomputes
 * `eventCount` and `startedAt`/`completedAt`, and returns turns sorted in
 * ascending `startedAt` order (matching `/turns`). Pure and preserves the
 * `existing` reference when unchanged so live polling avoids redundant renders.
 */
export function mergeTurnPages(
  existing: readonly api.TurnTrace[],
  incoming: readonly api.TurnTrace[],
): api.TurnTrace[] {
  const byId = new Map<string, api.TurnTrace>();
  const order: string[] = [];

  const absorb = (turn: api.TurnTrace) => {
    const prev = byId.get(turn.turnId);
    if (!prev) {
      byId.set(turn.turnId, turn);
      order.push(turn.turnId);
      return;
    }
    // Same turnId: merge, deduplicate, and re-sort events by seq/timestamp.
    const eventByKey = new Map<string, api.TraceEvent>();
    for (const event of [...prev.events, ...turn.events]) {
      const key = traceEventKey(event);
      // The newer window wins when an in-flight event is returned again with
      // the same identity but updated payload data.
      eventByKey.set(key, event);
    }
    const events = [...eventByKey.values()];
    events.sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.timestamp.localeCompare(b.timestamp),
    );
    byId.set(turn.turnId, {
      ...prev,
      startedAt: earlierTimestamp(prev.startedAt, turn.startedAt),
      completedAt: laterTimestamp(prev.completedAt, turn.completedAt),
      eventCount: events.length,
      events,
    });
  };

  for (const turn of existing) absorb(turn);
  for (const turn of incoming) absorb(turn);

  const merged = order
    .map((id) => byId.get(id) as api.TurnTrace)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const unchanged =
    merged.length === existing.length &&
    merged.every((turn, index) => {
      const previous = existing[index];
      return (
        previous !== undefined &&
        turn.turnId === previous.turnId &&
        turn.flowId === previous.flowId &&
        turn.traceId === previous.traceId &&
        turn.startedAt === previous.startedAt &&
        turn.completedAt === previous.completedAt &&
        turn.eventCount === previous.eventCount &&
        turn.events.length === previous.events.length &&
        turn.events.every((event, eventIndex) => {
          const previousEvent = previous.events[eventIndex];
          return (
            previousEvent !== undefined &&
            traceEventKey(event) === traceEventKey(previousEvent) &&
            JSON.stringify(event) === JSON.stringify(previousEvent)
          );
        })
      );
    });

  return unchanged ? (existing as api.TurnTrace[]) : merged;
}
