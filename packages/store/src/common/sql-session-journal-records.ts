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

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  lt,
  sql,
} from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import {
  cursorAfterOrder,
  cursorAfterWhere,
  writeOrderAsc,
  writeOrderPageOrder,
  writeOrderPageWhere,
} from "./cursor.js";
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
  CompactedTurnMessageTag,
  CursorPageOpts,
  DataStore,
  PaginationOpts,
  PlayerInputRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
  TurnMessageStats,
} from "../types.js";

type TraceEventsTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
  seq: Column;
  turnId: Column;
  type: Column;
};
type TurnMessagesTable = Table & {
  sessionId: Column;
  turnId: Column;
  createdAt: Column;
  order: Column;
  id: Column;
  sourceType: Column;
  sourceRuntimeId: Column;
  compactedAtTurnId: Column;
};
type PlayerInputsTable = Table & {
  id: Column;
  sessionId: Column;
  formId: Column;
  createdAt: Column;
};
type SessionSummariesTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
};

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
  | "getTraceEventById"
  | "listTraceEvents"
  | "queryTraceEvents"
  | "listTraceEventsPage"
  | "deleteTraceEventsBefore"
  | "appendTurnMessage"
  | "listTurnMessages"
  | "listUncompactedTurnMessages"
  | "listTurnMessagesAfter"
  | "getTurnMessageStats"
  | "listRecentTurnMessages"
  | "listCompactedTurnMessageTags"
  | "tagTurnMessagesCompacted"
  | "retagCompactedTurnMessages"
  | "savePlayerInput"
  | "listPlayerInputs"
  | "getLatestPlayerInput"
  | "saveSessionSummary"
  | "listSessionSummaries"
  | "deleteSessionSummaries"
>;

export function createSqlSessionJournalRecords(
  deps: SqlSessionJournalDeps,
): SqlSessionJournalRecords {
  const { runner, tables, json, values } = deps;
  const { traceEvents, turnMessages, playerInputs, sessionSummaries } = tables;
  const { byteOrder } = runner;
  // Two messages of one millisecond come in pipeline order (the player's
  // message is 0, a runtime's the rank of its stage), then by ID: without a
  // tie-break the engine was free to return them either way.
  const turnMessageOrder = [
    asc(turnMessages.createdAt),
    asc(turnMessages.order),
    asc(byteOrder(turnMessages.id)),
  ];

  return {
    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await runner.insert(traceEvents, {
        ...values.traceEventInsert(record),
        seq: runner.nextWriteOrderSeq(traceEvents, record),
      });
    },

    async listTraceEvents(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TraceEventRecord[]> {
      const rows = await runner.select<TraceEventRow>(traceEvents, {
        where: eq(traceEvents.sessionId, sessionId),
        // A total order, so offset pagination cannot swap rows between pages
        // (media GC pages through this), and the order the page read gives.
        orderBy: writeOrderAsc(traceEvents, byteOrder),
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toTraceEventRecord(row, json));
    },

    async getTraceEventById(sessionId, id) {
      const row = await runner.selectFirst<TraceEventRow>(traceEvents, {
        where: and(
          eq(traceEvents.sessionId, sessionId),
          eq(traceEvents.id, id),
        ),
      });
      return row ? toTraceEventRecord(row, json) : null;
    },

    async queryTraceEvents(sessionId, options) {
      const rows = await runner.select<TraceEventRow>(traceEvents, {
        where: and(
          eq(traceEvents.sessionId, sessionId),
          options.turnId === undefined
            ? undefined
            : eq(traceEvents.turnId, options.turnId),
          options.types === undefined
            ? undefined
            : inArray(traceEvents.type, [...options.types]),
          options.excludeTypes?.length
            ? notInArray(traceEvents.type, [...options.excludeTypes])
            : undefined,
        ),
        orderBy: options.newestFirst
          ? writeOrderPageOrder(traceEvents, byteOrder)
          : writeOrderAsc(traceEvents, byteOrder),
        limit: options.limit,
      });
      return rows.map((row) => toTraceEventRecord(row, json));
    },

    async deleteTraceEventsBefore(
      sessionId: string,
      before: string,
    ): Promise<void> {
      await runner.delete(
        traceEvents,
        and(
          eq(traceEvents.sessionId, sessionId),
          lt(traceEvents.createdAt, before),
        ),
      );
    },

    async listTraceEventsPage(
      sessionId: string,
      opts: CursorPageOpts,
    ): Promise<TraceEventRecord[]> {
      if (opts.limit <= 0) return [];
      const rows = await runner.select<TraceEventRow>(traceEvents, {
        where: writeOrderPageWhere(
          traceEvents,
          sessionId,
          opts.before,
          byteOrder,
        ),
        orderBy: writeOrderPageOrder(traceEvents, byteOrder),
        limit: opts.limit,
      });
      return rows.reverse().map((row) => toTraceEventRecord(row, json));
    },

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await runner.insert(turnMessages, values.turnMessageInsert(record));
    },

    async listTurnMessages(
      sessionId: string,
      options?: PaginationOpts & { readonly turnId?: string },
    ): Promise<TurnMessageRecord[]> {
      const rows = await runner.select<TurnMessageRow>(turnMessages, {
        where: and(
          eq(turnMessages.sessionId, sessionId),
          options?.turnId === undefined
            ? undefined
            : eq(turnMessages.turnId, options.turnId),
        ),
        orderBy: turnMessageOrder,
        limit: options?.limit,
        offset: options?.offset,
      });
      return rows.map((row) => toTurnMessageRecord(row, json));
    },

    async listUncompactedTurnMessages(
      sessionId: string,
      limit?: number,
    ): Promise<TurnMessageRecord[]> {
      const rows = await runner.select<TurnMessageRow>(turnMessages, {
        where: and(
          eq(turnMessages.sessionId, sessionId),
          isNull(turnMessages.compactedAtTurnId),
        ),
        orderBy: turnMessageOrder,
        limit,
      });
      return rows.map((row) => toTurnMessageRecord(row, json));
    },

    async listTurnMessagesAfter(
      sessionId: string,
      after: { readonly createdAt: string; readonly id: string } | null,
      limit: number,
    ): Promise<TurnMessageRecord[]> {
      if (limit <= 0) return [];
      const rows = await runner.select<TurnMessageRow>(turnMessages, {
        where: cursorAfterWhere(turnMessages, sessionId, after, byteOrder),
        orderBy: cursorAfterOrder(turnMessages, byteOrder),
        limit,
      });
      return rows.map((row) => toTurnMessageRecord(row, json));
    },

    async getTurnMessageStats(sessionId: string): Promise<TurnMessageStats> {
      // COUNT(*) arrives as number on SQLite and string on PG.
      const [row] = await runner.select<{ count: number | string }>(
        turnMessages,
        {
          columns: { count: sql`count(*)` },
          where: and(
            eq(turnMessages.sessionId, sessionId),
            eq(turnMessages.sourceType, "player"),
          ),
        },
      );
      return { playerMessageCount: Number(row?.count ?? 0) };
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
        // `turnMessageOrder` downwards: the tail of `listTurnMessages`, cut
        // at the same rows when several share a createdAt.
        orderBy: [
          desc(turnMessages.createdAt),
          desc(turnMessages.order),
          desc(byteOrder(turnMessages.id)),
        ],
        limit,
      });
      return rows.reverse().map((row) => toTurnMessageRecord(row, json));
    },

    async listCompactedTurnMessageTags(
      sessionId: string,
    ): Promise<CompactedTurnMessageTag[]> {
      return runner.select<CompactedTurnMessageTag>(turnMessages, {
        columns: {
          id: turnMessages.id,
          summaryId: turnMessages.compactedAtTurnId,
        },
        where: and(
          eq(turnMessages.sessionId, sessionId),
          isNotNull(turnMessages.compactedAtTurnId),
        ),
        orderBy: turnMessageOrder,
      });
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

    async retagCompactedTurnMessages(
      sessionId: string,
      summaryId: string,
      sourceSummaryIds?: readonly string[],
    ): Promise<void> {
      if (sourceSummaryIds?.length === 0) return;
      await runner.update(
        turnMessages,
        { compactedAtTurnId: summaryId },
        and(
          eq(turnMessages.sessionId, sessionId),
          sourceSummaryIds
            ? inArray(turnMessages.compactedAtTurnId, [...sourceSummaryIds])
            : isNotNull(turnMessages.compactedAtTurnId),
        ),
      );
    },

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await runner.insert(playerInputs, values.playerInputInsert(record));
    },

    async getLatestPlayerInput(
      sessionId: string,
    ): Promise<PlayerInputRecord | null> {
      const rows = await runner.select<PlayerInputRow>(playerInputs, {
        where: eq(playerInputs.sessionId, sessionId),
        orderBy: [
          desc(playerInputs.createdAt),
          desc(byteOrder(playerInputs.id)),
        ],
        limit: 1,
      });
      return rows[0] ? toPlayerInputRecord(rows[0], json) : null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      const rows = await runner.select<PlayerInputRow>(playerInputs, {
        where: eq(playerInputs.sessionId, sessionId),
        // Oldest first, so the last row is the latest submission. Without an
        // order PostgreSQL returns rows as they lie on disk.
        orderBy: [asc(playerInputs.createdAt), asc(byteOrder(playerInputs.id))],
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
        orderBy: [
          asc(sessionSummaries.createdAt),
          asc(byteOrder(sessionSummaries.id)),
        ],
      });
      return rows.map((row) => toSessionSummaryRecord(row, json));
    },

    async deleteSessionSummaries(
      sessionId: string,
      summaryIds?: readonly string[],
    ): Promise<void> {
      if (summaryIds?.length === 0) return;
      await runner.delete(
        sessionSummaries,
        and(
          eq(sessionSummaries.sessionId, sessionId),
          summaryIds
            ? inArray(sessionSummaries.id, [...summaryIds])
            : undefined,
        ),
      );
    },
  };
}
