/**
 * SQLite plugin-config records (save / get) — a thin adapter over the shared
 * `common/sql-plugin-config-records.ts` query layer. Supplies the SQLite runner,
 * SQLite tables, and SQLite JSON read/write gateways; all query logic is shared
 * with the PostgreSQL backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlPluginConfigRecords } from "../common/sql-plugin-config-records.js";
import type { SqlPluginConfigRecords } from "../common/sql-plugin-config-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqlitePluginConfigs = SqlPluginConfigRecords;

export function createSqlitePluginConfigs(db: SqliteDb): SqlitePluginConfigs {
  return createSqlPluginConfigRecords({
    runner: createSqliteSqlRunner(db),
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
    tables: { pluginConfigs: schema.pluginConfigs },
  });
}
