import type {
  SessionSummaryEntry,
  SessionSummaryModel,
  UiSlotValue,
} from "./extension-points.js";

/** The contract's cap on entries across all providers. */
const MAX_ENTRIES = 16;

/**
 * Build a `session.summary@1` result: the entries earlier providers supplied
 * plus this provider's own. Summary providers run as a chain, so returning
 * only your own entries would drop everyone else's.
 */
export function appendSummaryEntries(
  previous: UiSlotValue,
  entries: readonly SessionSummaryEntry[],
): SessionSummaryModel {
  const earlier = previous && "entries" in previous ? previous.entries : [];
  return { entries: [...earlier, ...entries].slice(0, MAX_ENTRIES) };
}
