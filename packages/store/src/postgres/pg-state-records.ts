/**
 * PostgreSQL state records (schemas / entries / changes) — a thin adapter over
 * the shared `common/sql-state-records.ts` query layer. Supplies the PG runner,
 * PG tables, and PG JSON read/write gateways; all query logic is shared with the
 * SQLite backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlStateRecords } from "../common/sql-state-records.js";
import type { SqlStateRecords } from "../common/sql-state-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgStateRecords = SqlStateRecords;

export function createPgStateRecords(getDb: () => PgDb): PgStateRecords {
  return createSqlStateRecords({
    runner: createPgSqlRunner(getDb),
    tables: {
      stateSchemas: schema.stateSchemas,
      stateEntries: schema.stateEntries,
      stateChanges: schema.stateChanges,
    },
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
  });
}
