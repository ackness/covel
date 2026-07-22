/**
 * PostgreSQL runtime-export records — a thin adapter over the shared
 * `common/sql-export-records.ts` query layer. Supplies the PG runner, table, and
 * JSON read/write gateways; all query logic is shared with SQLite.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlExportRecords } from "../common/sql-export-records.js";
import type { SqlExportRecords } from "../common/sql-export-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgExportRecords = SqlExportRecords;

export function createPgExportRecords(getDb: () => PgDb): PgExportRecords {
  return createSqlExportRecords({
    runner: createPgSqlRunner(getDb),
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
    tables: {
      runtimeExports: schema.runtimeExports,
    },
  });
}
