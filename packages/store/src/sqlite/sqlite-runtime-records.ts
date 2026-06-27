/**
 * SQLite runtime records (turn / runtime results, tool calls, runtime outputs,
 * interactions) — a thin adapter over the shared
 * `common/sql-runtime-records.ts` query layer. Supplies the SQLite runner,
 * SQLite tables, and SQLite JSON read/write gateways; all query logic is shared
 * with the PostgreSQL backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlRuntimeRecords } from "../common/sql-runtime-records.js";
import type { SqlRuntimeRecords } from "../common/sql-runtime-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteRuntimeRecords = SqlRuntimeRecords;

export function createSqliteRuntimeRecords(db: SqliteDb): SqliteRuntimeRecords {
  return createSqlRuntimeRecords({
    runner: createSqliteSqlRunner(db),
    tables: {
      turnResults: schema.turnResults,
      runtimeResults: schema.runtimeResults,
      toolCalls: schema.toolCalls,
      runtimeOutputs: schema.runtimeOutputs,
      interactionRecords: schema.interactionRecords,
    },
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
  });
}
