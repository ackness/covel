import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlTurnNodeRecords } from "../common/sql-turn-node-records.js";
import type { SqliteDb } from "./sqlite-types.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import * as schema from "./schema.js";

export function createSqliteTurnNodeRecords(db: SqliteDb) {
  return createSqlTurnNodeRecords({
    runner: createSqliteSqlRunner(db),
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
    table: schema.turnNodes,
  });
}
