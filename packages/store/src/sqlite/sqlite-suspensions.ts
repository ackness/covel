import type { DataStore, SuspensionRecord } from "../types.js";
import {
  toJson,
  toSuspensionRecord,
  type SuspensionRow,
} from "./sqlite-store-mappers.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type SqliteSuspensions = Pick<
  DataStore,
  | "saveSuspension"
  | "getSuspension"
  | "markSuspensionResolved"
  | "claimSuspension"
  | "listSuspensions"
  | "deleteSuspension"
>;

export function createSqliteSuspensions(
  sqlite: SqliteConnection,
): SqliteSuspensions {
  return {
    async saveSuspension(record: SuspensionRecord): Promise<void> {
      sqlite
        .prepare(
          `INSERT INTO suspensions (id, session_id, turn_id, runtime_id, plugin_id, reason, resume_schema, pending_continuation, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason,
           resume_schema = excluded.resume_schema,
           pending_continuation = excluded.pending_continuation,
           resolved_at = excluded.resolved_at`,
        )
        .run(
          record.id,
          record.sessionId,
          record.turnId,
          record.runtimeId,
          record.pluginId,
          record.reason,
          toJson(record.resumeSchema),
          toJson(record.pendingContinuation),
          record.createdAt,
          record.resolvedAt ?? null,
        );
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      const row = sqlite
        .prepare("SELECT * FROM suspensions WHERE id = ?")
        .get(id) as SuspensionRow | undefined;
      return row ? toSuspensionRecord(row) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      sqlite
        .prepare("UPDATE suspensions SET resolved_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    },

    async claimSuspension(id: string): Promise<boolean> {
      // Atomic compare-and-swap: SQLite executes a single UPDATE as a
      // serialized write, so two concurrent claims cannot both succeed.
      const result = sqlite
        .prepare(
          "UPDATE suspensions SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
        )
        .run(`claimed:${new Date().toISOString()}`, id);
      return result.changes === 1;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const rows = sqlite
        .prepare(
          "SELECT * FROM suspensions WHERE session_id = ? ORDER BY created_at ASC",
        )
        .all(sessionId) as SuspensionRow[];
      return rows.map(toSuspensionRecord);
    },

    async deleteSuspension(id: string): Promise<void> {
      sqlite.prepare("DELETE FROM suspensions WHERE id = ?").run(id);
    },
  };
}
