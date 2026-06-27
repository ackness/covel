/**
 * PostgreSQL world records — a thin adapter over the shared
 * `common/sql-world-records.ts` query layer. Supplies the PG runner, the PG
 * `worlds` table, and the PG JSON read/write gateways; all query logic is
 * shared with the SQLite backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlWorldRecords } from "../common/sql-world-records.js";
import type { SqlWorldRecords } from "../common/sql-world-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgWorldRecords = SqlWorldRecords;

export function createPgWorldRecords(getDb: () => PgDb): PgWorldRecords {
  return createSqlWorldRecords({
    runner: createPgSqlRunner(getDb),
    worlds: schema.worlds,
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
  });
}
