/**
 * SQLite instance-scoped plugin KV: thin adapter over `common/sql-instance-data-records.ts`.
 */

import {
  createSqlInstanceDataRecords,
  type SqlInstanceDataRecords,
} from "../common/sql-instance-data-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export function createSqliteInstanceData(db: SqliteDb): SqlInstanceDataRecords {
  return createSqlInstanceDataRecords({
    runner: createSqliteSqlRunner(db),
    instanceData: schema.instanceData,
  });
}
