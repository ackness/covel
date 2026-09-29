import type { TurnResultRecord } from "@covel/store";

/** Recursive artifacts share a turn ID but are not independently retryable turns. */
export function topLevelTurnResults(
  rows: readonly TurnResultRecord[],
): TurnResultRecord[] {
  return rows.filter(
    (row) => row.origin !== "recursive" && row.parentTurnId !== row.turnId,
  );
}
