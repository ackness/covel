/**
 * SQLite-backed DataStore implementation using Drizzle ORM + better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DataStore, StoreTransaction } from "../types.js";
import type { VectorModelOps, VectorStoreCapability } from "../vector-store.js";
import * as schema from "./schema.js";
import { createSqliteDataCrud } from "./sqlite-data-crud.js";
import { createSqlitePluginConfigs } from "./sqlite-plugin-configs.js";
import { createSqliteRuntimeRecords } from "./sqlite-runtime-records.js";
import { createSqliteSessionRecords } from "./sqlite-session-records.js";
import { createSqliteSessions } from "./sqlite-sessions.js";
import { createSqliteSnapshotRecords } from "./sqlite-snapshot-records.js";
import { createTables } from "./sqlite-store-mappers.js";
import { createSqliteState } from "./sqlite-state.js";
import { createSqliteTransactions } from "./sqlite-transactions.js";
import { createSqliteVectorCapability } from "./sqlite-vector.js";
import { createSqliteWorlds } from "./sqlite-worlds.js";

// ── Factory ─────────────────────────────────────────────────────

export function createSqliteStore(
  dbPath: string,
): DataStore & Partial<VectorStoreCapability & VectorModelOps> {
  // Ensure the parent directory exists. Without this, a fresh checkout that
  // points STORE_BACKEND=sqlite at the default `./data/covel.db` path will
  // crash on boot because better-sqlite3 refuses to open a file in a
  // non-existent directory. This is cheap and idempotent.
  const dir = dirname(dbPath);
  if (dir && dir !== "." && dir !== ":memory:") {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Fall through — better-sqlite3 will produce a clearer error if the
      // path is truly invalid.
    }
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  createTables(sqlite);

  // Attempt to load sqlite-vec. If the optional binary is missing, vector
  // methods are simply absent from the returned store and supportsVector()
  // will return false — callers fall back to structured retrieval.
  const vectorCapability = createSqliteVectorCapability(sqlite);

  // Data methods first; the transaction scope is the same single-connection
  // store, so `withTransaction` hands `fn` these data methods.
  const data = {
    ...createSqliteSessions(sqlite, db),
    ...createSqliteRuntimeRecords(db),
    ...createSqliteState(db),
    ...createSqliteSessionRecords(db),
    ...createSqliteDataCrud(db),
    ...createSqlitePluginConfigs(db),
    ...createSqliteWorlds(db),
    ...createSqliteSnapshotRecords(db),
  };

  const baseStore: DataStore = {
    ...data,
    ...createSqliteTransactions(
      sqlite,
      () => data as unknown as StoreTransaction,
    ),

    async close(): Promise<void> {
      sqlite.close();
    },
  };

  // Compose the optional vector capability onto the base store. When
  // sqlite-vec could not be loaded, the returned store has no vector
  // methods and `supportsVector(store)` returns false.
  if (vectorCapability) {
    return Object.assign(baseStore, vectorCapability);
  }
  return baseStore;
}
