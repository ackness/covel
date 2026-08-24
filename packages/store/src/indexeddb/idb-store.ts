/**
 * IndexedDB DataStore implementation using the `idb` library.
 *
 * Used by the web frontend's `local` storage mode (offline / no-server
 * scenarios). The default mode is `remote` (server-side SQLite/PG via the
 * HTTP API); IDB only kicks in when the user explicitly opts into local
 * mode from the frontend's data-service layer.
 */

import type { DataStore, StoreTransaction } from "../types.js";
import {
  nestedWithTransactionError,
  SERIALIZED_NESTING_REASON,
} from "../tx-nesting-error.js";
import { openBrowserIdb } from "./idb-db.js";
import { createIdbMutationTracker } from "./idb-transaction.js";
import { createIdbSessionStore } from "./idb-session-store.js";
import { createIdbRuntimeStore } from "./idb-runtime-store.js";
import { createIdbLifecycleStore } from "./idb-lifecycle-store.js";
import { createIdbExportStore } from "./idb-export-store.js";
import { createIdbPluginStore } from "./idb-plugin-store.js";
import { createIdbWorldStore } from "./idb-world-store.js";
import { createIdbPlayerStore } from "./idb-player-store.js";
import { createIdbWorldDataStore } from "./idb-world-data-store.js";
import { createIdbPersistenceStore } from "./idb-persistence-store.js";
import { STORE_WRITE_METHODS } from "../store-write-methods.js";

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

  // Data methods first; the transaction scope is the same store (writes go
  // through the snapshot-tracking mutation layer).
  const data = {
    ...createIdbSessionStore(ctx),
    ...createIdbRuntimeStore(ctx),
    ...createIdbPluginStore(ctx),
    ...createIdbWorldStore(ctx),
    ...createIdbPlayerStore(ctx),
    ...createIdbWorldDataStore(ctx),
    ...createIdbPersistenceStore(ctx),
    ...createIdbLifecycleStore(ctx),
    ...createIdbExportStore(ctx),
  };
  const scope = data as unknown as StoreTransaction;

  // The mutation tracker holds a single snapshot at a time. Transactions and
  // root writes therefore share one FIFO: a root write cannot enter another
  // caller's snapshot and disappear when that transaction rolls back. The tx
  // callback receives the raw scope above, so its own writes run inline.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = chain.then(fn);
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  const gatedData = { ...data } as Record<string, unknown>;
  for (const name of Object.keys(gatedData)) {
    const original = gatedData[name];
    if (typeof original !== "function" || !STORE_WRITE_METHODS.has(name)) {
      continue;
    }
    const fn = original as (...args: unknown[]) => unknown;
    gatedData[name] = (...args: unknown[]) =>
      enqueue(async () => fn.apply(data, args));
  }

  // Nesting guard. AsyncLocalStorage is unavailable in the browser bundle, so
  // IdbStore uses a coarse synchronous flag: it reliably rejects a nested
  // withTransaction (the deadlock case — the inner call would queue behind the
  // outer one on `chain`), and may also reject a genuinely concurrent call that
  // is issued while another transaction's callback is mid-flight. That
  // false-positive edge is irrelevant for IdbStore's single-user local mode.
  // The Node backends (Sqlite/Memory/Pg) use the precise AsyncLocalStorage guard.
  let withTxActive = false;

  return {
    ...gatedData,

    withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      // Checked at CALL time (before chaining) so a nested call rejects instead
      // of deadlocking behind the outer transaction on the chain.
      if (withTxActive) {
        return Promise.reject(
          nestedWithTransactionError(
            "IdbStore",
            "idb",
            SERIALIZED_NESTING_REASON,
          ),
        );
      }
      return enqueue(async () => {
        withTxActive = true;
        try {
          await mutations.beginTx();
          try {
            const result = await fn(scope);
            await mutations.commitTx();
            return result;
          } catch (err) {
            await mutations.rollbackTx();
            throw err;
          }
        } finally {
          withTxActive = false;
        }
      });
    },

    async close(): Promise<void> {
      db.close();
    },
  } as DataStore;
}
