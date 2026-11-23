/**
 * SQLite persistent plugin grants: thin adapter over `common/sql-plugin-grant-records.ts`.
 */

import {
  createSqlPluginGrantRecords,
  type SqlPluginGrantRecords,
} from "../common/sql-plugin-grant-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export function createSqlitePluginGrants(db: SqliteDb): SqlPluginGrantRecords {
  return createSqlPluginGrantRecords({
    runner: createSqliteSqlRunner(db),
    pluginGrants: schema.pluginGrants,
  });
}
