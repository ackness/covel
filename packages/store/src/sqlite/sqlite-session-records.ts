/**
 * SQLite session content + journal records — a thin adapter over the shared
 * `common/sql-session-content-records.ts` and
 * `common/sql-session-journal-records.ts` query layers. Supplies the SQLite
 * runner, SQLite tables, and SQLite JSON read/write gateways; all query logic is
 * shared with the PostgreSQL backend.
 *
 * Plugin configs are NOT included here — they live in the separate
 * `sqlite-plugin-configs.ts` factory (which delegates to the same shared
 * plugin-config module). Two turn-message writers stay inline because they are
 * not clean mirrors of the PG backend:
 *  - `appendTurnMessage` omits `compactedAtTurnId` on insert (PG persists it) —
 *    a source-level divergence we deliberately preserve.
 *  - `tagTurnMessagesCompacted` is an UPDATE, which the insert/select/delete
 *    {@link SqlRunner} does not model.
 */

import { and, eq } from "drizzle-orm";

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonReader } from "../common/json-readers.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import { createSqlSessionContentRecords } from "../common/sql-session-content-records.js";
import type { SqlSessionContentRecords } from "../common/sql-session-content-records.js";
import { createSqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { SqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { DataStore, TurnMessageRecord } from "../types.js";
import * as schema from "./schema.js";
import { toJson } from "./sqlite-store-mappers.js";
import { createSqliteSqlRunner } from "./sqlite-sql-runner.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteSessionRecords = SqlSessionContentRecords &
  SqlSessionJournalRecords &
  Pick<DataStore, "appendTurnMessage" | "tagTurnMessagesCompacted">;

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

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      db.insert(schema.turnMessages)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          sourceType: record.sourceType,
          sourcePluginId: record.sourcePluginId ?? null,
          sourceRuntimeId: record.sourceRuntimeId ?? null,
          role: record.role,
          name: record.name ?? null,
          content: record.content,
          ui: record.ui != null ? toJson(record.ui) : null,
          pendingInput:
            record.pendingInput != null ? toJson(record.pendingInput) : null,
          order: record.order,
          createdAt: record.createdAt,
        })
        .run();
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      for (const msgId of messageIds) {
        db.update(schema.turnMessages)
          .set({ compactedAtTurnId: summaryId })
          .where(
            and(
              eq(schema.turnMessages.sessionId, sessionId),
              eq(schema.turnMessages.id, msgId),
            ),
          )
          .run();
      }
    },
  };
}
