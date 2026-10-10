/**
 * SQLite server settings: a thin adapter over the shared
 * `common/sql-server-setting-records.ts` query layer.
 */

import { createSqlServerSettingRecords } from "../common/sql-server-setting-records.js";
import type { SqlServerSettingRecords } from "../common/sql-server-setting-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export function createSqliteServerSettings(
  db: SqliteDb,
): SqlServerSettingRecords {
  return createSqlServerSettingRecords({
    runner: createSqliteSqlRunner(db),
    serverSettings: schema.serverSettings,
  });
}
