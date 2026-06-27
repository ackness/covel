/**
 * PostgreSQL snapshot + suspension records — a thin adapter over the shared
 * `common/sql-snapshot-records.ts` query layer. All query logic (upsert column
 * sets, ordering, the atomic `claimSuspension` compare-and-swap) lives in the
 * shared module; this file only supplies the PG runner, tables, and JSON
 * read/write gateways.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlSnapshotRecords } from "../common/sql-snapshot-records.js";
import type { SqlSnapshotRecords } from "../common/sql-snapshot-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgSnapshotRecords = SqlSnapshotRecords;

export function createPgSnapshotRecords(getDb: () => PgDb): PgSnapshotRecords {
  return createSqlSnapshotRecords({
    runner: createPgSqlRunner(getDb),
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
    tables: {
      stateSnapshots: schema.stateSnapshots,
      suspensions: schema.suspensions,
    },
  });
}
