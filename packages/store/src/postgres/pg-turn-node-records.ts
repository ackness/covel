import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlTurnNodeRecords } from "../common/sql-turn-node-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export function createPgTurnNodeRecords(getDb: () => PgDb) {
  return createSqlTurnNodeRecords({
    runner: createPgSqlRunner(getDb),
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
    table: schema.turnNodes,
  });
}
