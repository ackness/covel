/**
 * PostgreSQL server settings: a thin adapter over the shared
 * `common/sql-server-setting-records.ts` query layer.
 */

import { createSqlServerSettingRecords } from "../common/sql-server-setting-records.js";
import type { SqlServerSettingRecords } from "../common/sql-server-setting-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export function createPgServerSettingRecords(
  getDb: () => PgDb,
): SqlServerSettingRecords {
  return createSqlServerSettingRecords({
    runner: createPgSqlRunner(getDb),
    serverSettings: schema.serverSettings,
  });
}
