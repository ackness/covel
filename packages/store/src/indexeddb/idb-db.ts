import { openDB, type IDBPDatabase } from "idb";
import {
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
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
  "pluginConfigs",
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
  "runtime_outputs",
  "interaction_records",
] as const;

export type IdbStoreName = (typeof IDB_OBJECT_STORES)[number];
export type BrowserIdbDatabase = IDBPDatabase;

export async function openBrowserIdb(
  dbName = BROWSER_IDB_DATABASE_NAME,
): Promise<BrowserIdbDatabase> {
  return openDB(dbName, BROWSER_IDB_SCHEMA_VERSION, {
    upgrade(db, oldVersion) {
      upgradeBrowserIdbSchema(db, oldVersion);
    },
  });
}
