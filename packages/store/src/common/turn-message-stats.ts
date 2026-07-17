/**
 * In-memory fallback for {@link TurnMessageStats}, shared by the Memory and
 * IndexedDB backends (the SQL backends resolve the same aggregate as a grouped
 * COUNT query in `sql-session-journal-records.ts`).
 */

import type { TurnMessageRecord, TurnMessageStats } from "../types.js";

export function computeTurnMessageStats(
  records: readonly TurnMessageRecord[],
): TurnMessageStats {
  let playerMessageCount = 0;
  const runtimeMessageCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.sourceType === "player") {
      playerMessageCount += 1;
    } else if (record.sourceType === "runtime" && record.sourceRuntimeId) {
      runtimeMessageCounts[record.sourceRuntimeId] =
        (runtimeMessageCounts[record.sourceRuntimeId] ?? 0) + 1;
    }
  }
  return { playerMessageCount, runtimeMessageCounts };
}
