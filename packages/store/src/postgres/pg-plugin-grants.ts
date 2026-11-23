/**
 * PostgreSQL persistent plugin grants: thin adapter over `common/sql-plugin-grant-records.ts`.
 */

import {
  createSqlPluginGrantRecords,
  type SqlPluginGrantRecords,
} from "../common/sql-plugin-grant-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export function createPgPluginGrants(getDb: () => PgDb): SqlPluginGrantRecords {
  return createSqlPluginGrantRecords({
    runner: createPgSqlRunner(getDb),
    pluginGrants: schema.pluginGrants,
  });
}
