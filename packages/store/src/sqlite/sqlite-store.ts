/**
 * SQLite-backed DataStore implementation using Drizzle ORM + better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  acquireSqliteConnection,
  getConnectionWriteGate,
  releaseSqliteConnection,
} from "./shared-connection.js";

import type { DataStore, StoreTransaction } from "../types.js";
import {
  STORE_WRITE_METHODS,
  VECTOR_WRITE_METHODS,
} from "../store-write-methods.js";
import type { VectorModelOps, VectorStoreCapability } from "../vector-store.js";
import * as schema from "./schema.js";
import { createSqliteDataCrud } from "./sqlite-data-crud.js";
import { createSqliteRuntimeRecords } from "./sqlite-runtime-records.js";
import { createSqliteSessionRecords } from "./sqlite-session-records.js";
import { createSqliteLifecycleRecords } from "./sqlite-lifecycle-records.js";
import { createSqliteExportRecords } from "./sqlite-export-records.js";
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

  // Shared per-file connection: the mirror media store must reuse this exact
  // connection, otherwise its writes deadlock against an open withTransaction
  // write lock (see shared-connection.ts).
  const sqlite = acquireSqliteConnection(dbPath);

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
    ...createSqliteWorlds(db),
    ...createSqliteSnapshotRecords(db),
    ...createSqliteLifecycleRecords(db),
    ...createSqliteExportRecords(db),
  };

  // One connection means a transaction cannot isolate: a write issued
  // elsewhere while a transaction is open would land inside it and be lost on
  // its rollback. The gate puts transactions and outside-of-transaction
  // writes on one queue. The transaction scope keeps the UNGATED methods —
  // writes inside the callback belong to that transaction and must run
  // inline, not queue behind it.
  // Shared per-connection so the mirror media store queues on the same gate.
  const gate = getConnectionWriteGate(sqlite);
  const gatedData = gate.gateWrites(data, STORE_WRITE_METHODS);

  const baseStore: DataStore = {
    ...gatedData,
    ...createSqliteTransactions(
      sqlite,
      () => data as unknown as StoreTransaction,
      gate,
    ),

    async close(): Promise<void> {
      releaseSqliteConnection(sqlite);
    },
  };

  // Compose the optional vector capability onto the base store. When
  // sqlite-vec could not be loaded, the returned store has no vector
  // methods and `supportsVector(store)` returns false.
  if (vectorCapability) {
    // Vector mutators run on the same connection as `data`, so they need the
    // same gate — an ungated upsert issued while another session's
    // transaction is open would join it and vanish on its rollback.
    return Object.assign(
      baseStore,
      gate.gateWrites(vectorCapability, VECTOR_WRITE_METHODS),
    );
  }
  return baseStore;
}
