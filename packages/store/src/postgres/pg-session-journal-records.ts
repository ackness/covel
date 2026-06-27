/**
 * PostgreSQL session-journal records — a thin adapter over the shared
 * `common/sql-session-journal-records.ts` query layer for the mirror methods
 * (trace events, turn-message reads, player inputs, session summaries).
 *
 * Two turn-message writers stay inline here because they are NOT clean mirrors
 * of the SQLite backend (see the shared module's header):
 *  - `appendTurnMessage` persists `compactedAtTurnId`, which the SQLite legacy
 *    insert omits — a source-level divergence we deliberately preserve.
 *  - `tagTurnMessagesCompacted` is an UPDATE, which the insert/select/delete
 *    {@link SqlRunner} does not model.
 */

import { and, eq } from "drizzle-orm";

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonReader } from "../common/json-readers.js";
import { pgJsonWriter } from "../common/json-writers.js";
import { createSqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { SqlSessionJournalRecords } from "../common/sql-session-journal-records.js";
import type { DataStore, TurnMessageRecord } from "../types.js";
import type { PgDb } from "./pg-db.js";
import { createPgSqlRunner } from "./pg-sql-runner.js";
import * as schema from "./schema.js";

export type PgSessionJournalRecords = SqlSessionJournalRecords &
  Pick<DataStore, "appendTurnMessage" | "tagTurnMessagesCompacted">;

export function createPgSessionJournalRecords(
  getDb: () => PgDb,
): PgSessionJournalRecords {
  return {
    ...createSqlSessionJournalRecords({
      runner: createPgSqlRunner(getDb),
      json: pgJsonReader,
      values: makeInsertValues(pgJsonWriter),
      tables: {
        traceEvents: schema.traceEvents,
        turnMessages: schema.turnMessages,
        playerInputs: schema.playerInputs,
        sessionSummaries: schema.sessionSummaries,
      },
    }),

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await getDb()
        .insert(schema.turnMessages)
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
          ui: record.ui ?? null,
          pendingInput: record.pendingInput ?? null,
          order: record.order,
          createdAt: record.createdAt,
          compactedAtTurnId: record.compactedAtTurnId ?? null,
        });
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      if (messageIds.length === 0) return;
      for (const msgId of messageIds) {
        await getDb()
          .update(schema.turnMessages)
          .set({ compactedAtTurnId: summaryId })
          .where(
            and(
              eq(schema.turnMessages.sessionId, sessionId),
              eq(schema.turnMessages.id, msgId),
            ),
          );
      }
    },
  };
}
