/**
 * SQLite-backed DataStore implementation using Drizzle ORM + `node:sqlite`.
 *
 * All operations are synchronous under the hood (`node:sqlite` is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import { applyPluginDataBatchCas } from "../common/plugin-data-batch-cas.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { drizzleNodeSqlite } from "./drizzle-node-sqlite.js";
import { reclaimSqliteFreePages } from "./node-sqlite.js";
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
import {
  createSqliteSavepoint,
  createSqliteTransactions,
} from "./sqlite-transactions.js";
import { createSqliteVectorCapability } from "./sqlite-vector.js";
import { createSqliteWorlds } from "./sqlite-worlds.js";

// ── Factory ─────────────────────────────────────────────────────

export function createSqliteStore(
  dbPath: string,
): DataStore & Partial<VectorStoreCapability & VectorModelOps> {
  // Ensure the parent directory exists. Without this, a fresh checkout that
  // points STORE_BACKEND=sqlite at the default `./data/covel.db` path will
  // crash on boot because SQLite refuses to open a file in a
  // non-existent directory. This is cheap and idempotent.
  const dir = dirname(dbPath);
  if (dir && dir !== "." && dir !== ":memory:") {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Fall through — opening the database gives a clearer error if the
      // path is truly invalid.
    }
  }

  // Shared per-file connection: the mirror media store must reuse this exact
  // connection, otherwise its writes deadlock against an open withTransaction
  // write lock (see shared-connection.ts).
  const sqlite = acquireSqliteConnection(dbPath);

  const db = drizzleNodeSqlite(sqlite, schema);

  createTables(sqlite);

  // Attempt to load sqlite-vec. If the optional binary is missing, vector
  // methods are simply absent from the returned store and supportsVector()
  // will return false — callers fall back to structured retrieval.
  const vectorCapability = createSqliteVectorCapability(sqlite);

  // Data methods first; the transaction scope is the same single-connection
  // store, so `withTransaction` hands `fn` these data methods.
  const records = {
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
  const data: StoreTransaction = {
    ...records,
    async deleteTraceEventsBefore(sessionId, before) {
      await records.deleteTraceEventsBefore(sessionId, before);
      // Traces are the bulk of a long-lived file; hand their pages back.
      reclaimSqliteFreePages(sqlite);
    },
    async compareAndSetPluginDataBatch(sessionId, pluginId, entries) {
      const ownTransaction = !sqlite.isTransaction;
      if (ownTransaction) sqlite.exec("BEGIN IMMEDIATE");
      try {
        const applied = await applyPluginDataBatchCas(
          records,
          sessionId,
          pluginId,
          entries,
        );
        if (ownTransaction) sqlite.exec("COMMIT");
        return applied;
      } catch (error) {
        if (ownTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  // One connection exposes its own uncommitted rows to every statement issued
  // through that handle. Queue every root operation (reads included) behind an
  // open transaction so a concurrent caller cannot observe a row that is later
  // rolled back. The transaction scope keeps the UNGATED methods — operations
  // through `tx` belong to that transaction and run inline.
  // Shared per-connection so the mirror media store queues on the same gate.
  const gate = getConnectionWriteGate(sqlite);
  const gatedData = gate.gateWrites(
    data,
    new Set([...Object.keys(data), ...STORE_WRITE_METHODS]),
  );

  // The transaction scope is the ungated data plus nested savepoints; the
  // root store never exposes `savepoint`.
  const txScope: StoreTransaction = {
    ...data,
    savepoint: createSqliteSavepoint(sqlite, () => txScope),
  };

  const baseStore: DataStore = {
    ...gatedData,
    ...createSqliteTransactions(sqlite, () => txScope, gate),

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
      gate.gateWrites(
        vectorCapability,
        new Set([...Object.keys(vectorCapability), ...VECTOR_WRITE_METHODS]),
      ),
    );
  }
  return baseStore;
}
