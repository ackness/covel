/**
 * PostgreSQL session-journal records — a thin adapter over the shared
 * `common/sql-session-journal-records.ts` query layer (trace events,
 * turn-message reads/writes, player inputs, session summaries). All query logic
 * lives in the shared module; this file only supplies the PG runner, tables, and
 * JSON read/write gateways.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { SqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgSessionJournalRecords = SqlSessionJournalRecords;

export function createPgSessionJournalRecords(
  getDb: () => PgDb,
): PgSessionJournalRecords {
  return createSqlSessionJournalRecords({
    runner: createPgSqlRunner(getDb),
    json: pgJsonReader,
    values: makeInsertValues(pgJsonWriter),
    tables: {
      traceEvents: schema.traceEvents,
      turnMessages: schema.turnMessages,
      playerInputs: schema.playerInputs,
      sessionSummaries: schema.sessionSummaries,
    },
  });
}
