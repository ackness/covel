import type { DataStore, SnapshotRecord } from "../types.js";
import {
  toJson,
  toSnapshotRecord,
  type SnapshotRow,
} from "./sqlite-store-mappers.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type SqliteSnapshots = Pick<
  DataStore,
  "saveSnapshot" | "getSnapshot" | "listSnapshots" | "deleteSnapshot"
>;

export function createSqliteSnapshots(
  sqlite: SqliteConnection,
): SqliteSnapshots {
  return {
    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      sqlite
        .prepare(
          `INSERT INTO state_snapshots (id, session_id, turn_id, kind, parent_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           turn_id = excluded.turn_id,
           kind = excluded.kind,
           parent_id = excluded.parent_id,
           payload = excluded.payload`,
        )
        .run(
          record.id,
          record.sessionId,
          record.turnId,
          record.kind,
          record.parentId ?? null,
          toJson(record.payload),
          record.createdAt,
        );
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      const row = sqlite
        .prepare("SELECT * FROM state_snapshots WHERE id = ?")
        .get(id) as SnapshotRow | undefined;
      return row ? toSnapshotRecord(row) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = sqlite
        .prepare(
          "SELECT * FROM state_snapshots WHERE session_id = ? ORDER BY created_at ASC",
        )
        .all(sessionId) as SnapshotRow[];
      return rows.map(toSnapshotRecord);
    },

    async deleteSnapshot(id: string): Promise<void> {
      sqlite.prepare("DELETE FROM state_snapshots WHERE id = ?").run(id);
    },
  };
}
