/**
 * SQLite state records (schemas / entries / changes) — a thin adapter over the
 * shared `common/sql-state-records.ts` query layer. Supplies the SQLite runner,
 * SQLite tables, and SQLite JSON read/write gateways; all query logic is shared
 * with the PostgreSQL backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlStateRecords } from "../common/sql-state-records.js";
import type { SqlStateRecords } from "../common/sql-state-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteState = SqlStateRecords;

export function createSqliteState(db: SqliteDb): SqliteState {
  return createSqlStateRecords({
    runner: createSqliteSqlRunner(db),
    tables: {
      stateSchemas: schema.stateSchemas,
      stateEntries: schema.stateEntries,
      stateChanges: schema.stateChanges,
    },
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
  });
}
