/**
 * SQLite runtime-export records — a thin adapter over the shared
 * `common/sql-export-records.ts` query layer. Supplies the SQLite runner, table,
 * and JSON read/write gateways; all query logic is shared with PG.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlExportRecords } from "../common/sql-export-records.js";
import type { SqlExportRecords } from "../common/sql-export-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteExportRecords = SqlExportRecords;

export function createSqliteExportRecords(db: SqliteDb): SqliteExportRecords {
  return createSqlExportRecords({
    runner: createSqliteSqlRunner(db),
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
    tables: {
      runtimeExports: schema.runtimeExports,
    },
  });
}
