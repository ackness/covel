/**
 * IndexedDB DataStore implementation using the `idb` library.
 *
 * Used by the web frontend's `local` storage mode (offline / no-server
 * scenarios). The default mode is `remote` (server-side SQLite/PG via the
 * HTTP API); IDB only kicks in when the user explicitly opts into local
 * mode from the frontend's data-service layer.
 */

import type { DataStore } from "../types.js";
import { openBrowserIdb } from "./idb-db.js";
import { createIdbMutationTracker } from "./idb-transaction.js";
import { createIdbSessionStore } from "./idb-session-store.js";
import { createIdbRuntimeStore } from "./idb-runtime-store.js";
import { createIdbPluginStore } from "./idb-plugin-store.js";
import { createIdbWorldStore } from "./idb-world-store.js";
import { createIdbPlayerStore } from "./idb-player-store.js";
import { createIdbWorldDataStore } from "./idb-world-data-store.js";
import { createIdbPersistenceStore } from "./idb-persistence-store.js";

export { createIndexedDbMediaStore } from "./idb-media-store.js";
export type { IndexedDbMediaStoreOptions } from "./idb-media-store.js";
export {
  APP_KV_STORE_EXECUTION_STEPS,
  APP_KV_STORE_STATE_PATCHES,
  APP_KV_STORE_STATE_SNAPSHOTS,
  APP_KV_STORE_SUBMITTED_BLOCKS,
  APP_KV_STORE_WORLD_OVERLAYS,
  BROWSER_IDB_DATABASE_NAME,
  BROWSER_IDB_SCHEMA_VERSION,
  MEDIA_CACHE_STORE_BLOBS,
  upgradeBrowserIdbSchema,
} from "./idb-schema.js";

export async function createIdbStore(dbName?: string): Promise<DataStore> {
  const db = await openBrowserIdb(dbName);
  const mutations = createIdbMutationTracker(db);
  const ctx = { db, mutations };

  return {
    ...createIdbSessionStore(ctx),
    ...createIdbRuntimeStore(ctx),
    ...createIdbPluginStore(ctx),
    ...createIdbWorldStore(ctx),
    ...createIdbPlayerStore(ctx),
    ...createIdbWorldDataStore(ctx),
    ...createIdbPersistenceStore(ctx),

    beginTx: mutations.beginTx,
    commitTx: mutations.commitTx,
    rollbackTx: mutations.rollbackTx,

    async close(): Promise<void> {
      db.close();
    },
  } as DataStore;
}
