import { openDB, type IDBPDatabase } from "idb";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
  backfillSnapshotMetadata,
  upgradeBrowserIdbSchema,
} from "./idb-schema.js";

export const IDB_OBJECT_STORES = [
  "sessions",
  "turnResults",
  "runtimeResults",
  "toolCalls",
  "stateSchemas",
  "stateEntries",
  "stateChanges",
  "events",
  "approvals",
  "messages",
  "characters",
  "worlds",
  "traceEvents",
  "turnMessages",
  "playerInputs",
  "plugin_data",
  "world_data_import_ledger",
  "working_memory",
  "lorebook_entries",
  "sessionSummaries",
  "suspensions",
  "state_snapshots",
  "state_snapshot_metadata",
  "runtime_outputs",
  "interaction_records",
  "logical_turn_ledger",
  "setup_attempts",
  "job_status",
] as const;

export type IdbStoreName = (typeof IDB_OBJECT_STORES)[number];
export type BrowserIdbDatabase = IDBPDatabase;

export async function openBrowserIdb(
  dbName = BROWSER_IDB_DATABASE_NAME,
): Promise<BrowserIdbDatabase> {
  const db = await openDB(dbName, BROWSER_IDB_SCHEMA_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      upgradeBrowserIdbSchema(db, oldVersion, transaction);
      if (oldVersion > 0 && oldVersion < 12) {
        await backfillSnapshotMetadata(transaction);
      }
    },
  });

  // The browser's lightweight KV/media helpers share this database and may be
  // the first opener to perform a v12 upgrade without running the IDB backend's
  // async migration. Repair that path once when the row counts differ.
  const [snapshotCount, metadataCount] = await Promise.all([
    db.count("state_snapshots"),
    db.count("state_snapshot_metadata"),
  ]);
  if (snapshotCount !== metadataCount) {
    const tx = db.transaction(
      ["state_snapshots", "state_snapshot_metadata"],
      "readwrite",
    );
    const metadata = tx.objectStore("state_snapshot_metadata");
    await metadata.clear();
    let cursor = await tx.objectStore("state_snapshots").openCursor();
    while (cursor) {
      const record = cursor.value as {
        id: string;
        sessionId: string;
        turnId: string;
        kind: string;
        parentId?: string;
        createdAt: string;
        payload: unknown;
      };
      await metadata.put({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        kind: record.kind,
        ...(record.parentId != null ? { parentId: record.parentId } : {}),
        createdAt: record.createdAt,
        size: JSON.stringify(record.payload).length,
      });
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  return db;
}
