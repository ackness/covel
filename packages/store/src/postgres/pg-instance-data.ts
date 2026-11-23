/**
 * PostgreSQL instance-scoped plugin KV: thin adapter over `common/sql-instance-data-records.ts`.
 */

import {
  createSqlInstanceDataRecords,
  type SqlInstanceDataRecords,
} from "../common/sql-instance-data-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export function createPgInstanceData(
  getDb: () => PgDb,
): SqlInstanceDataRecords {
  return createSqlInstanceDataRecords({
    runner: createPgSqlRunner(getDb),
    instanceData: schema.instanceData,
  });
}
