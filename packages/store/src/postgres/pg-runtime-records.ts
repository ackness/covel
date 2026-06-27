/**
 * PostgreSQL runtime records (turn / runtime results, tool calls, runtime
 * outputs, interactions) — a thin adapter over the shared
 * `common/sql-runtime-records.ts` query layer. Supplies the PG runner, PG
 * tables, and PG JSON read/write gateways; all query logic is shared with the
 * SQLite backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlRuntimeRecords } from "../common/sql-runtime-records.js";
import type { SqlRuntimeRecords } from "../common/sql-runtime-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgRuntimeRecords = SqlRuntimeRecords;

export function createPgRuntimeRecords(getDb: () => PgDb): PgRuntimeRecords {
  return createSqlRuntimeRecords({
    runner: createPgSqlRunner(getDb),
    tables: {
      turnResults: schema.turnResults,
      runtimeResults: schema.runtimeResults,
      toolCalls: schema.toolCalls,
      runtimeOutputs: schema.runtimeOutputs,
      interactionRecords: schema.interactionRecords,
    },
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
  });
}
