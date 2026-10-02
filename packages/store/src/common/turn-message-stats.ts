/**
 * In-memory fallback for {@link TurnMessageStats}, shared by the Memory and
 * IndexedDB backends (the SQL backends resolve the same aggregate as a COUNT
 * query in `sql-session-journal-records.ts`).
 */

import type { TurnMessageRecord, TurnMessageStats } from "../types.js";

export function computeTurnMessageStats(
  records: readonly TurnMessageRecord[],
): TurnMessageStats {
  return {
    playerMessageCount: records.filter(
      (record) => record.sourceType === "player",
    ).length,
  };
}
