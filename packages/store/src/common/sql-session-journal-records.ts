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
 * Two turn-message writers are intentionally NOT shared and remain inline in
 * each backend adapter:
 *  - `appendTurnMessage` — the two backends genuinely diverge at the source
 *    level: PG persists `compactedAtTurnId ?? null` on insert, SQLite omits the
 *    column entirely (relying on its nullable default). The rows are identical
 *    for the only path that calls it (compactedAtTurnId is always absent on a
 *    fresh append), but unifying would silently change SQLite's behaviour in the
 *    hypothetical non-null case, so it is left untouched.
 *  - `tagTurnMessagesCompacted` — an UPDATE, which the insert/select/delete-only
 *    {@link SqlRunner} does not model. Migrating it would require widening the
 *    shared runner primitive, out of scope for this pass.
 */

import { and, asc, eq } from "drizzle-orm";
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

type TraceEventsTable = Table & { sessionId: Column };
type TurnMessagesTable = Table & { sessionId: Column; createdAt: Column };
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
    "traceEventInsert" | "playerInputInsert" | "sessionSummaryInsert"
  >;
}

export type SqlSessionJournalRecords = Pick<
  DataStore,
  | "addTraceEvent"
  | "listTraceEvents"
  | "listTurnMessages"
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
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toTraceEventRecord(row, json));
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
