/**
 * PostgreSQL-backed DataStore factory using Drizzle ORM + postgres.js.
 *
 * Method groups live in sibling modules; this file owns connection setup,
 * schema initialization, transaction routing, composition, and lifecycle.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import type { DataStore } from "../types.js";
import type { VectorModelOps, VectorStoreCapability } from "../vector-store.js";
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

  let db: typeof pooledDb = pooledDb;
  const txAdapter = createPgTxAdapter({
    pooledDb,
    setDb: (next) => {
      db = next;
    },
  });
  const getDb = () => db;

  const baseStore: DataStore = {
    ...createPgSessionRecords(getDb),
    ...createPgRuntimeRecords(getDb),
    ...createPgStateRecords(getDb),
    ...createPgSessionContentRecords(getDb),
    ...createPgDataCrud(getDb),
    ...createPgWorldRecords(getDb),
    ...createPgSessionJournalRecords(getDb),
    ...createPgSnapshotRecords(getDb),

    beginTx: txAdapter.beginTx,
    commitTx: txAdapter.commitTx,
    rollbackTx: txAdapter.rollbackTx,

    async close(): Promise<void> {
      await txAdapter.closeActiveTx();
      await client.end();
    },
  };

  return Object.assign(baseStore, createPgVectorCapability(client));
}
