/**
 * SQLite snapshot + suspension records — a thin adapter over the shared
 * `common/sql-snapshot-records.ts` query layer. Supplies the SQLite runner,
 * SQLite tables, and SQLite JSON read/write gateways; all query logic is shared
 * with the PostgreSQL backend.
 *
 * This replaces the last hand-written SQL in the SQLite backend: the former
 * `sqlite-snapshots.ts` / `sqlite-suspensions.ts` modules built raw
 * `sqlite.prepare(...)` statements. They now flow through Drizzle + the shared
 * {@link SqlRunner}, byte-for-byte identical in column set, conflict set, and
 * JSON handling.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlSnapshotRecords } from "../common/sql-snapshot-records.js";
import type { SqlSnapshotRecords } from "../common/sql-snapshot-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteSnapshotRecords = SqlSnapshotRecords;

export function createSqliteSnapshotRecords(
  db: SqliteDb,
): SqliteSnapshotRecords {
  return createSqlSnapshotRecords({
    runner: createSqliteSqlRunner(db),
    json: sqliteJsonReader,
    values: makeInsertValues(sqliteJsonWriter),
    tables: {
      stateSnapshots: schema.stateSnapshots,
      suspensions: schema.suspensions,
    },
  });
}
