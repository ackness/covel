/**
 * PostgreSQL scheduling-redesign lifecycle records — a thin adapter over the
 * shared `common/sql-lifecycle-records.ts` query layer. Supplies the PG runner,
 * tables, and JSON read/write gateways; all query logic is shared with SQLite.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlLifecycleRecords } from "../common/sql-lifecycle-records.js";
import type { SqlLifecycleRecords } from "../common/sql-lifecycle-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgLifecycleRecords = SqlLifecycleRecords;

export function createPgLifecycleRecords(
  getDb: () => PgDb,
): PgLifecycleRecords {
  return createSqlLifecycleRecords({
    runner: createPgSqlRunner(getDb),
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
    tables: {
      logicalTurnLedger: schema.logicalTurnLedger,
      setupAttempts: schema.setupAttempts,
      jobStatus: schema.jobStatus,
    },
  });
}
