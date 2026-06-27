/**
 * SQLite data-CRUD (plugin data / working memory / world-data ledger /
 * lorebook) — a thin adapter over the shared `common/sql-data-crud.ts` query
 * layer. Supplies the SQLite runner, SQLite tables, and SQLite JSON read/write
 * gateways; all query logic is shared with the PostgreSQL backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlDataCrud } from "../common/sql-data-crud.js";
import type { SqlDataCrud } from "../common/sql-data-crud.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteDataCrud = SqlDataCrud;

export function createSqliteDataCrud(db: SqliteDb): SqliteDataCrud {
  return createSqlDataCrud({
    runner: createSqliteSqlRunner(db),
    tables: {
      pluginData: schema.pluginData,
      workingMemory: schema.workingMemory,
      worldDataImportLedger: schema.worldDataImportLedger,
      lorebookEntries: schema.lorebookEntries,
    },
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
  });
}
