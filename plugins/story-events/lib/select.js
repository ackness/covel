import { compareText } from "@covel/plugin-handlers-utils";
import { evaluateCondition } from "./conditions.js";

/** Whether an event may fire again given its previous reveal record. */
function available(event, record, turn) {
  if (event.enabled === false) return false;
  if (!record) return true;
  if (event.once !== false) return false;
  const cooldown = Number.isInteger(event.cooldownTurns)
    ? event.cooldownTurns
    : 0;
  return turn - record.lastTurn > cooldown;
}

/**
 * Choose at most one event to reveal this turn. Higher `priority` wins; ties
 * break by event ID so the choice is deterministic across retries.
 */
export function selectEvent({ events, revealed, state, turn }) {
  const diagnostics = [];
  const candidates = [];
  const chainState = {
    ...state,
    revealed,
    turn,
    eventIds: new Set(events.map((event) => event.id)),
  };
  for (const event of events) {
    if (!available(event, revealed[event.id], turn)) continue;
    const { met, issues } = evaluateCondition(event.when, chainState);
    // Issues name only IDs and fields, never the hidden payload.
    for (const issue of issues) diagnostics.push(`${event.id}: ${issue}`);
    if (met) candidates.push(event);
  }
  candidates.sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || compareText(a.id, b.id),
  );
  return {
    event: candidates[0] ?? null,
    diagnostics: [...new Set(diagnostics)],
  };
}
