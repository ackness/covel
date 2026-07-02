/**
 * PostgreSQL session-content records (events / approvals / messages /
 * characters) — a thin adapter over the shared
 * `common/sql-session-content-records.ts` query layer. Supplies the PG runner,
 * PG tables, and PG JSON read/write gateways; all query logic is shared with the
 * SQLite backend.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlSessionContentRecords } from "../common/sql-session-content-records.js";
import type { SqlSessionContentRecords } from "../common/sql-session-content-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgSessionContentRecords = SqlSessionContentRecords;

export function createPgSessionContentRecords(
  getDb: () => PgDb,
): PgSessionContentRecords {
  const runner = createPgSqlRunner(getDb);
  const json = pgJsonReader;
  const values = makeInsertValues(pgJsonWriter);
  return {
    ...createSqlSessionContentRecords({
      runner,
      json,
      values,
      tables: {
        events: schema.events,
        approvals: schema.approvals,
        messages: schema.messages,
        characters: schema.characters,
      },
    }),
  };
}
