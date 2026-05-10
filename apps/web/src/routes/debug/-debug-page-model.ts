import type * as api from "@/services/api.js";
import { categorize, type EventCategory } from "./-debug-helpers.js";

export type DebugView = "traces" | "data";

export interface VisibleTurn {
  turn: api.TurnTrace;
  turnIndex: number;
}

export function isManualTurn(turn: api.TurnTrace): boolean {
  return turn.events.some(
    (event) =>
      event.type === "turn.started" &&
      event.payload &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).manualTrigger,
  );
}

export function getStoryTurnCount(turns: api.TurnTrace[]): number {
  return turns.reduce((count, turn) => count + (isManualTurn(turn) ? 0 : 1), 0);
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
