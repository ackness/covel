/**
 * Backend-agnostic session-journal queries (trace events, turn-message reads,
 * player inputs, session summaries), shared by the PostgreSQL and SQLite
 * backends.
 *
 * Previously the corresponding methods inside
 * `postgres/pg-session-journal-records.ts` and `sqlite/sqlite-session-records.ts`
 * were mirrors differing only in the sync/async terminal and the JSON
 * serialization, both injected here via the {@link SqlRunner}, {@link JsonReader},
 * and the value builders ({@link InsertValueBuilders}).
 *
 * The two turn-message writers are now shared as well:
 *  - `appendTurnMessage` persists `compactedAtTurnId ?? null` on every backend
 *    via the {@link InsertValueBuilders.turnMessageInsert} builder. The legacy
 *    SQLite insert omitted the column entirely (relying on its nullable
 *    default), silently dropping a non-null `compactedAtTurnId` — a real
 *    data-loss divergence the shared builder fixes.
 *  - `tagTurnMessagesCompacted` is an UPDATE, now modelled by the shared
 *    {@link SqlRunner.update} primitive, with the empty-`messageIds` early
 *    return unified across both backends.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toPlayerInputRecord,
  toSessionSummaryRecord,
  toTraceEventRecord,
  toTurnMessageRecord,
} from "./mappers.js";
import type {
  PlayerInputRow,
  SessionSummaryRow,
  TurnMessageRow,
} from "./mappers/memory-mappers.js";
import type { TraceEventRow } from "./mappers/plugin-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  PaginationOpts,
  PlayerInputRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
} from "../types.js";

type TraceEventsTable = Table & { sessionId: Column; createdAt: Column };
type TurnMessagesTable = Table & {
  sessionId: Column;
  createdAt: Column;
  id: Column;
};
type PlayerInputsTable = Table & { sessionId: Column; formId: Column };
type SessionSummariesTable = Table & { sessionId: Column };

export interface SqlSessionJournalTables {
  readonly traceEvents: TraceEventsTable;
  readonly turnMessages: TurnMessagesTable;
  readonly playerInputs: PlayerInputsTable;
  readonly sessionSummaries: SessionSummariesTable;
}

export interface SqlSessionJournalDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSessionJournalTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "traceEventInsert"
    | "playerInputInsert"
    | "sessionSummaryInsert"
    | "turnMessageInsert"
  >;
}

export type SqlSessionJournalRecords = Pick<
  DataStore,
  | "addTraceEvent"
  | "listTraceEvents"
  | "appendTurnMessage"
  | "listTurnMessages"
  | "listRecentTurnMessages"
  | "tagTurnMessagesCompacted"
  | "savePlayerInput"
  | "getPlayerInput"
  | "listPlayerInputs"
  | "saveSessionSummary"
  | "listSessionSummaries"
  | "deleteSessionSummaries"
>;

export function createSqlSessionJournalRecords(
  deps: SqlSessionJournalDeps,
): SqlSessionJournalRecords {
  const { runner, tables, json, values } = deps;
  const { traceEvents, turnMessages, playerInputs, sessionSummaries } = tables;

  return {
    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await runner.insert(traceEvents, values.traceEventInsert(record));
    },

    async listTraceEvents(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TraceEventRecord[]> {
      const rows = await runner.select<TraceEventRow>(traceEvents, {
        where: eq(traceEvents.sessionId, sessionId),
        orderBy: [asc(traceEvents.createdAt)],
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toTraceEventRecord(row, json));
    },

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await runner.insert(turnMessages, values.turnMessageInsert(record));
    },

    async listTurnMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TurnMessageRecord[]> {
      const rows = await runner.select<TurnMessageRow>(turnMessages, {
        where: eq(turnMessages.sessionId, sessionId),
        orderBy: [asc(turnMessages.createdAt)],
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toTurnMessageRecord(row, json));
    },

    async listRecentTurnMessages(
      sessionId: string,
      limit: number,
    ): Promise<TurnMessageRecord[]> {
      if (limit <= 0) return [];
      // Fetch the newest `limit` rows via a descending, limited query so a long
      // session never streams its whole history into memory, then reverse to
      // restore the oldest-first order every caller expects from the tail.
      const rows = await runner.select<TurnMessageRow>(turnMessages, {
        where: eq(turnMessages.sessionId, sessionId),
        orderBy: [desc(turnMessages.createdAt)],
        limit,
      });
      return rows.reverse().map((row) => toTurnMessageRecord(row, json));
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      if (messageIds.length === 0) return;
      // One bulk UPDATE ... WHERE id IN (...) instead of N serially-awaited
      // single-row updates (the compacted window grows on long sessions).
      await runner.update(
        turnMessages,
        { compactedAtTurnId: summaryId },
        and(
          eq(turnMessages.sessionId, sessionId),
          inArray(turnMessages.id, [...messageIds]),
        ),
      );
    },

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await runner.insert(playerInputs, values.playerInputInsert(record));
    },

    async getPlayerInput(
      sessionId: string,
      formId: string,
    ): Promise<PlayerInputRecord | null> {
      const row = await runner.selectFirst<PlayerInputRow>(playerInputs, {
        where: and(
          eq(playerInputs.sessionId, sessionId),
          eq(playerInputs.formId, formId),
        ),
      });
      return row ? toPlayerInputRecord(row, json) : null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      const rows = await runner.select<PlayerInputRow>(playerInputs, {
        where: eq(playerInputs.sessionId, sessionId),
      });
      return rows.map((row) => toPlayerInputRecord(row, json));
    },

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      await runner.insert(
        sessionSummaries,
        values.sessionSummaryInsert(record),
      );
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      const rows = await runner.select<SessionSummaryRow>(sessionSummaries, {
        where: eq(sessionSummaries.sessionId, sessionId),
      });
      return rows.map((row) => toSessionSummaryRecord(row, json));
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      await runner.delete(
        sessionSummaries,
        eq(sessionSummaries.sessionId, sessionId),
      );
    },
  };
}
