/**
 * PostgreSQL-backed DataStore factory using Drizzle ORM + postgres.js.
 *
 * Method groups live in sibling modules; this file owns connection setup,
 * schema initialization, transaction routing, composition, and lifecycle.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import type { DataStore, StoreTransaction } from "../types.js";
import {
  INDEPENDENT_CONNECTION_NESTING_REASON,
  nestedWithTransactionError,
} from "../tx-nesting-error.js";
import { createTxNestingGuard } from "../tx-nesting-guard.js";
import type { VectorModelOps, VectorStoreCapability } from "../vector-store.js";
import type { PgDb } from "./pg-db.js";
import { createPgDataCrud } from "./pg-data-crud.js";
import { createPgRuntimeRecords } from "./pg-runtime-records.js";
import { createPgSessionContentRecords } from "./pg-session-content-records.js";
import { createPgSessionJournalRecords } from "./pg-session-journal-records.js";
import { createPgSessionRecords } from "./pg-session-records.js";
import { createPgSnapshotRecords } from "./pg-snapshot-records.js";
import { CREATE_TABLES_SQL, DROP_ALL_SQL } from "./pg-store-mappers.js";
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

  // The pgvector extension is enabled lazily by pg-vector.ts on first vector
  // operation, so non-vector PG deployments can boot on plain postgres.
  if (options?.freshSchema) {
    // Run the destructive DROP+CREATE on a single dedicated connection so the
    // two statements cannot land on different pool connections and race the
    // system catalog — concurrent/stale-catalog DROP+CREATE otherwise trips
    // `pg_type_typname_nsp_index` duplicate-key under rapid schema recreation
    // (the test harness rebuilds the schema once per test). Production boots
    // with `freshSchema: false` and is unaffected.
    const ddl = postgres(databaseUrl, { max: 1 });
    try {
      // Also drop the dynamically-created per-model vector tables
      // (`vec_mem_m{id}`, created lazily by pg-vector.ts). They are NOT in
      // ALL_TABLE_NAMES, so DROP_ALL_SQL alone would leave them behind — and
      // since `vector_models.id` is a SERIAL that resets to 1 after the static
      // schema is recreated, a fresh store would resolve back to `vec_mem_m1`
      // and find stale rows. A fresh PG store must start empty, exactly like a
      // fresh MemoryStore/SqliteStore — backend behaviour has to be identical.
      const vecTables = await ddl<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE 'vec_mem_%'
      `;
      for (const { tablename } of vecTables) {
        await ddl.unsafe(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
      }
      await ddl.unsafe(DROP_ALL_SQL);
      await ddl.unsafe(CREATE_TABLES_SQL);
    } finally {
      await ddl.end();
    }
  } else {
    await client.unsafe(CREATE_TABLES_SQL);
  }

  // Root data methods always run on the pool. `withTransaction` never touches
  // this handle — it builds its own tx-scoped data view bound to a private
  // connection, so concurrent `withTransaction` calls are fully isolated.
  const getDb = (): PgDb => pooledDb;

  // PgStore runs each withTransaction on its own pooled connection, so nesting
  // does not deadlock (unlike the serialized backends). It is still rejected for
  // a uniform cross-backend contract and to prevent a silent atomicity surprise:
  // a nested call would run on a *separate* connection, so an outer rollback
  // would not undo the inner commit. The guard rejects only true re-entrant
  // nesting; independent concurrent calls still run on their own connections.
  const nesting = createTxNestingGuard();

  const baseStore: DataStore = {
    ...buildPgData(getDb),

    /**
     * Scoped, isolation-correct transaction. Drizzle reserves a dedicated
     * pooled connection for the callback; the tx-scoped store view routes every
     * write to that connection. Returns on commit, rolls back + rethrows on
     * error. No shared handle is mutated, so concurrent calls run on
     * independent connections. Nested calls (from inside a callback) are
     * rejected — see the `nesting` guard above.
     */
    withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      if (nesting.isNested()) {
        return Promise.reject(
          nestedWithTransactionError(
            "PgStore",
            "pg",
            INDEPENDENT_CONNECTION_NESTING_REASON,
          ),
        );
      }
      return nesting.runScoped(() =>
        pooledDb.transaction(async (tx) =>
          fn(buildPgData(() => tx as unknown as PgDb)),
        ),
      );
    },

    async close(): Promise<void> {
      await client.end();
    },
  };

  return Object.assign(baseStore, createPgVectorCapability(client));
}
