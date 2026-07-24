/**
 * SQLite scheduling-redesign lifecycle records — a thin adapter over the shared
 * `common/sql-lifecycle-records.ts` query layer. Supplies the SQLite runner,
 * tables, and JSON read/write gateways; all query logic is shared with PG.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlLifecycleRecords } from "../common/sql-lifecycle-records.js";
import type { SqlLifecycleRecords } from "../common/sql-lifecycle-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteLifecycleRecords = SqlLifecycleRecords;

export function createSqliteLifecycleRecords(
  db: SqliteDb,
): SqliteLifecycleRecords {
  return createSqlLifecycleRecords({
    runner: createSqliteSqlRunner(db),
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
    tables: {
      logicalTurnLedger: schema.logicalTurnLedger,
      setupAttempts: schema.setupAttempts,
      jobStatus: schema.jobStatus,
    },
  });
}
