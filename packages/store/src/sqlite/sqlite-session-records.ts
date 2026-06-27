/**
 * SQLite session content + journal records — a thin adapter over the shared
 * `common/sql-session-content-records.ts` and
 * `common/sql-session-journal-records.ts` query layers. Supplies the SQLite
 * runner, SQLite tables, and SQLite JSON read/write gateways; all query logic is
 * shared with the PostgreSQL backend.
 *
 * Plugin configs are NOT included here — they live in the separate
 * `sqlite-plugin-configs.ts` factory (which delegates to the same shared
 * plugin-config module). The turn-message writers (`appendTurnMessage`,
 * `tagTurnMessagesCompacted`) are also shared now — see the journal module.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlSessionContentRecords } from "../common/sql-session-content-records.js";
import type { SqlSessionContentRecords } from "../common/sql-session-content-records.js";
import { createSqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { SqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import * as schema from "./schema.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteSessionRecords = SqlSessionContentRecords &
  SqlSessionJournalRecords;

export function createSqliteSessionRecords(db: SqliteDb): SqliteSessionRecords {
  const runner = createSqliteSqlRunner(db);
  const json = sqliteJsonReader;
  const values = makeInsertValues(sqliteJsonWriter);
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
    ...createSqlSessionJournalRecords({
      runner,
      json,
      values,
      tables: {
        traceEvents: schema.traceEvents,
        turnMessages: schema.turnMessages,
        playerInputs: schema.playerInputs,
        sessionSummaries: schema.sessionSummaries,
      },
    }),
  };
}
