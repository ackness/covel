/**
 * Backend-agnostic runtime-domain queries (turn results, tool calls, runtime
 * outputs, interaction records), shared by the PostgreSQL and SQLite backends.
 *
 * Previously `postgres/pg-runtime-records.ts` and
 * `sqlite/sqlite-runtime-records.ts` were mirrors differing only in the
 * sync/async terminal and the JSON serialization. Both differences are injected
 * via the {@link SqlRunner}, {@link JsonReader}, and the value builders
 * ({@link InsertValueBuilders}), so this is the single source of truth for the
 * runtime-records surface.
 */

import { writeOrderAsc, writeOrderPageOrder } from "./cursor.js";
import { and, asc, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toInteractionRecordRow,
  toRuntimeOutputRecord,
  toToolCallRecord,
  toTurnResultRecord,
} from "./mappers.js";
import type {
  InteractionRow,
  RuntimeOutputRow,
  ToolCallRow,
  TurnResultRow,
} from "./mappers/runtime-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import { settleFailedRuntimeResults } from "../records/runtime-records.js";
import type {
  DataStore,
  FailedRuntimeResult,
  InteractionRecordFilters,
  InteractionRecordRow,
  RuntimeOutputFilters,
  RuntimeOutputRecord,
  ToolCallRecordRow,
  TurnResultRecord,
} from "../types.js";

type TurnResultsTable = Table & {
  seq: Column;
  id: Column;
  sessionId: Column;
  turnId: Column;
  createdAt: Column;
  parentTurnId: Column;
  origin: Column;
  commitStatus: Column;
};
type ToolCallsTable = Table & {
  id: Column;
  sessionId: Column;
  turnId: Column;
  createdAt: Column;
};
type RuntimeOutputsTable = Table & {
  sessionId: Column;
  id: Column;
  runtimeId: Column;
  pluginId: Column;
  timestamp: Column;
};
type InteractionRecordsTable = Table & {
  sessionId: Column;
  type: Column;
  source: Column;
  targetPluginId: Column;
  timestamp: Column;
};

export interface SqlRuntimeTables {
  readonly turnResults: TurnResultsTable;
  readonly toolCalls: ToolCallsTable;
  readonly runtimeOutputs: RuntimeOutputsTable;
  readonly interactionRecords: InteractionRecordsTable;
}

export interface SqlRuntimeRecordsDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlRuntimeTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "turnResultInsert"
    | "turnResultSettlement"
    | "toolCallInsert"
    | "runtimeOutputInsert"
    | "interactionRecordInsert"
  >;
}

export type SqlRuntimeRecords = Pick<
  DataStore,
  | "saveTurnResult"
  | "listTurnResults"
  | "queryTurnResults"
  | "setTurnResultCommitStatus"
  | "saveToolCall"
  | "listToolCalls"
  | "saveRuntimeOutput"
  | "getRuntimeOutput"
  | "listRuntimeOutputs"
  | "saveInteractionRecord"
  | "listInteractionRecords"
>;

export function createSqlRuntimeRecords(
  deps: SqlRuntimeRecordsDeps,
): SqlRuntimeRecords {
  const { runner, tables, json, values } = deps;
  const { turnResults, toolCalls, runtimeOutputs, interactionRecords } = tables;
  const { byteOrder } = runner;

  return {
    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await runner.insert(turnResults, {
        ...values.turnResultInsert(record),
        seq: runner.nextWriteOrderSeq(turnResults, record),
      });
    },

    async queryTurnResults(sessionId, options) {
      const rows = await runner.select<TurnResultRow>(turnResults, {
        where: and(
          eq(turnResults.sessionId, sessionId),
          isNull(turnResults.parentTurnId),
          ne(turnResults.origin, "recursive"),
          options.turnId === undefined
            ? undefined
            : eq(turnResults.turnId, options.turnId),
          options.since === undefined
            ? undefined
            : gte(turnResults.createdAt, options.since),
          options.origins === undefined
            ? undefined
            : inArray(turnResults.origin, [...options.origins]),
          options.commitStatus === undefined
            ? undefined
            : eq(turnResults.commitStatus, options.commitStatus),
        ),
        orderBy: options.newestFirst
          ? writeOrderPageOrder(turnResults, byteOrder)
          : writeOrderAsc(turnResults, byteOrder),
        limit: options.limit,
      });
      return rows.map((row) => toTurnResultRecord(row, json));
    },

    async listTurnResults(
      sessionId: string,
      limit?: number,
    ): Promise<TurnResultRecord[]> {
      const rows = await runner.select<TurnResultRow>(turnResults, {
        where: eq(turnResults.sessionId, sessionId),
        orderBy: writeOrderAsc(turnResults, byteOrder),
        limit,
      });
      return rows.map((row) => toTurnResultRecord(row, json));
    },

    async setTurnResultCommitStatus(
      sessionId: string,
      turnId: string,
      status: TurnResultRecord["commitStatus"],
      failedRuntimes: readonly FailedRuntimeResult[] = [],
    ): Promise<void> {
      const where = and(
        eq(turnResults.sessionId, sessionId),
        eq(turnResults.turnId, turnId),
      )!;
      if (failedRuntimes.length === 0) {
        await runner.update(turnResults, { commitStatus: status }, where);
        return;
      }
      // Nested recursive rows share the turnId; settle each row's results.
      const rows = await runner.select<TurnResultRow>(turnResults, { where });
      for (const row of rows) {
        const record = toTurnResultRecord(row, json);
        await runner.update(
          turnResults,
          values.turnResultSettlement({
            ...record,
            commitStatus: status,
            runtimeResults: settleFailedRuntimeResults(
              record.runtimeResults,
              failedRuntimes,
            ),
          }),
          eq(turnResults.id, row.id),
        );
      }
    },

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      await runner.insert(toolCalls, values.toolCallInsert(record));
    },

    async listToolCalls(
      sessionId: string,
      turnId?: string,
    ): Promise<ToolCallRecordRow[]> {
      const where =
        turnId != null
          ? and(
              eq(toolCalls.sessionId, sessionId),
              eq(toolCalls.turnId, turnId),
            )
          : eq(toolCalls.sessionId, sessionId);
      const rows = await runner.select<ToolCallRow>(toolCalls, {
        where,
        // Without an order PostgreSQL returns rows as they lie on disk.
        orderBy: [asc(toolCalls.createdAt), asc(byteOrder(toolCalls.id))],
      });
      return rows.map((row) => toToolCallRecord(row, json));
    },

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      await runner.insert(runtimeOutputs, values.runtimeOutputInsert(record));
    },

    async getRuntimeOutput(
      sessionId: string,
      id: string,
    ): Promise<RuntimeOutputRecord | null> {
      const row = await runner.selectFirst<RuntimeOutputRow>(runtimeOutputs, {
        where: and(
          eq(runtimeOutputs.sessionId, sessionId),
          eq(runtimeOutputs.id, id),
        ),
      });
      return row ? toRuntimeOutputRecord(row, json) : null;
    },

    async listRuntimeOutputs(
      sessionId: string,
      filters?: RuntimeOutputFilters,
    ): Promise<RuntimeOutputRecord[]> {
      const conditions: SQL[] = [eq(runtimeOutputs.sessionId, sessionId)];
      if (filters?.runtimeId) {
        conditions.push(eq(runtimeOutputs.runtimeId, filters.runtimeId));
      }
      if (filters?.pluginId) {
        conditions.push(eq(runtimeOutputs.pluginId, filters.pluginId));
      }
      if (filters?.sinceTimestamp) {
        conditions.push(gte(runtimeOutputs.timestamp, filters.sinceTimestamp));
      }
      const rows = await runner.select<RuntimeOutputRow>(runtimeOutputs, {
        where: and(...conditions),
        // `id` breaks same-timestamp ties so offset pagination is stable.
        orderBy: [
          desc(runtimeOutputs.timestamp),
          desc(byteOrder(runtimeOutputs.id)),
        ],
        limit: filters?.limit,
        offset: filters?.offset,
      });
      return rows.map((row) => toRuntimeOutputRecord(row, json));
    },

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      await runner.insert(
        interactionRecords,
        values.interactionRecordInsert(record),
      );
    },

    async listInteractionRecords(
      sessionId: string,
      filters?: InteractionRecordFilters,
    ): Promise<InteractionRecordRow[]> {
      const conditions: SQL[] = [eq(interactionRecords.sessionId, sessionId)];
      if (filters?.type) {
        conditions.push(eq(interactionRecords.type, filters.type));
      }
      if (filters?.source) {
        conditions.push(eq(interactionRecords.source, filters.source));
      }
      if (filters?.targetPluginId) {
        conditions.push(
          eq(interactionRecords.targetPluginId, filters.targetPluginId),
        );
      }
      const rows = await runner.select<InteractionRow>(interactionRecords, {
        where: and(...conditions),
        orderBy: [desc(interactionRecords.timestamp)],
        limit: filters?.limit,
      });
      return rows.map((row) => toInteractionRecordRow(row, json));
    },
  };
}
