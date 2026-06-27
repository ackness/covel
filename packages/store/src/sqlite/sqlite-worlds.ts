/**
 * SQLite world records — a thin adapter over the shared
 * `common/sql-world-records.ts` query layer. Supplies the SQLite runner, the
 * SQLite `worlds` table, and the SQLite JSON read/write gateways; all query
 * logic is shared with the PostgreSQL backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlWorldRecords } from "../common/sql-world-records.js";
import type { SqlWorldRecords } from "../common/sql-world-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteWorlds = SqlWorldRecords;

export function createSqliteWorlds(db: SqliteDb): SqliteWorlds {
  return createSqlWorldRecords({
    runner: createSqliteSqlRunner(db),
    worlds: schema.worlds,
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
  });
}
