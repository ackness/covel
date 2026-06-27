/**
 * PostgreSQL data-CRUD (plugin data / working memory / world-data ledger /
 * lorebook) — a thin adapter over the shared `common/sql-data-crud.ts` query
 * layer. Supplies the PG runner, PG tables, and PG JSON read/write gateways;
 * all query logic is shared with the SQLite backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlDataCrud } from "../common/sql-data-crud.js";
import type { SqlDataCrud } from "../common/sql-data-crud.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgDataCrud = SqlDataCrud;

export function createPgDataCrud(getDb: () => PgDb): PgDataCrud {
  return createSqlDataCrud({
    runner: createPgSqlRunner(getDb),
    tables: {
      pluginData: schema.pluginData,
      workingMemory: schema.workingMemory,
      worldDataImportLedger: schema.worldDataImportLedger,
      lorebookEntries: schema.lorebookEntries,
    },
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
  });
}
