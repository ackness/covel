/**
 * PostgreSQL-backed DataStore factory using Drizzle ORM + postgres.js.
 *
 * Method groups live in sibling modules; this file owns connection setup,
 * schema initialization, transaction routing, composition, and lifecycle.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import type { DataStore, StoreTransaction } from "../types.js";
import type { VectorModelOps, VectorStoreCapability } from "../vector-store.js";
import type { PgDb } from "./pg-db.js";
import { createPgDataCrud } from "./pg-data-crud.js";
import { createPgRuntimeRecords } from "./pg-runtime-records.js";
import { createPgSessionContentRecords } from "./pg-session-content-records.js";
import { createPgSessionJournalRecords } from "./pg-session-journal-records.js";
import { createPgSessionRecords } from "./pg-session-records.js";
import { createPgSnapshotRecords } from "./pg-snapshot-records.js";
import { CREATE_TABLES_SQL, DROP_ALL_SQL } from "./pg-store-mappers.js";
import { createPgTxAdapter } from "./pg-store-tx.js";
import { createPgStateRecords } from "./pg-state-records.js";
import { createPgVectorCapability } from "./pg-vector.js";
import { createPgWorldRecords } from "./pg-world-records.js";
import * as schema from "./schema.js";

export interface PgStoreOptions {
  /** Drop and recreate all tables (for test isolation). Default: false. */
  readonly freshSchema?: boolean;
}

/**
 * Compose every data read/write method against a `getDb` resolver. Reused for
 * both the root store (resolver returns the pool-bound or imperative-tx handle)
 * and each `withTransaction` scope (resolver returns that call's private tx
 * handle), so a tx scope is built without any shared/global state.
 */
function buildPgData(getDb: () => PgDb): StoreTransaction {
  return {
    ...createPgSessionRecords(getDb),
    ...createPgRuntimeRecords(getDb),
    ...createPgStateRecords(getDb),
    ...createPgSessionContentRecords(getDb),
    ...createPgDataCrud(getDb),
    ...createPgWorldRecords(getDb),
    ...createPgSessionJournalRecords(getDb),
    ...createPgSnapshotRecords(getDb),
  };
}

export async function createPgStore(
  databaseUrl: string,
  options?: PgStoreOptions,
): Promise<DataStore & VectorStoreCapability & VectorModelOps> {
  const client = postgres(databaseUrl);
  const pooledDb = drizzle(client, { schema });

  if (options?.freshSchema) {
    await client.unsafe(DROP_ALL_SQL);
  }

  // The pgvector extension is enabled lazily by pg-vector.ts on first vector
  // operation, so non-vector PG deployments can boot on plain postgres.
  await client.unsafe(CREATE_TABLES_SQL);

  // `imperativeTxDb` is null except while an imperative beginTx/commitTx window
  // is open, in which case the root data methods route through that tx handle.
  // The default is always `pooledDb`, and `withTransaction` never touches this
  // holder — it builds its own tx-scoped data view bound to a private
  // connection, so concurrent `withTransaction` calls are fully isolated and a
  // non-transactional caller never gets folded into someone else's tx via a
  // swapped global handle.
  let imperativeTxDb: typeof pooledDb | null = null;
  const txAdapter = createPgTxAdapter({
    pooledDb,
    setDb: (next) => {
      imperativeTxDb = next === pooledDb ? null : next;
    },
  });
  const getDb = (): PgDb => imperativeTxDb ?? pooledDb;

  const baseStore: DataStore = {
    ...buildPgData(getDb),

    beginTx: txAdapter.beginTx,
    commitTx: txAdapter.commitTx,
    rollbackTx: txAdapter.rollbackTx,

    /**
     * Scoped, isolation-correct transaction. Drizzle reserves a dedicated
     * pooled connection for the callback; the tx-scoped store view routes every
     * write to that connection. Returns on commit, rolls back + rethrows on
     * error. No shared handle is mutated, so concurrent calls run on
     * independent connections.
     */
    withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      return pooledDb.transaction(async (tx) =>
        fn(buildPgData(() => tx as unknown as PgDb)),
      );
    },

    async close(): Promise<void> {
      await txAdapter.closeActiveTx();
      await client.end();
    },
  };

  return Object.assign(baseStore, createPgVectorCapability(client));
}
