/**
 * Backend-agnostic runtime-domain queries (turn results, runtime results, tool
 * calls, runtime outputs, interaction records), shared by the PostgreSQL and
 * SQLite backends.
 *
 * Previously `postgres/pg-runtime-records.ts` and
 * `sqlite/sqlite-runtime-records.ts` were mirrors differing only in the
 * sync/async terminal and the JSON serialization. Both differences are injected
 * via the {@link SqlRunner}, {@link JsonReader}, and the value builders
 * ({@link InsertValueBuilders}), so this is the single source of truth for the
 * runtime-records surface.
 */

import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toInteractionRecordRow,
  toRuntimeOutputRecord,
  toRuntimeResultRecord,
  toToolCallRecord,
  toTurnResultRecord,
} from "./mappers.js";
import type {
  InteractionRow,
  RuntimeOutputRow,
  RuntimeResultRow,
  ToolCallRow,
  TurnResultRow,
} from "./mappers/runtime-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  InteractionRecordFilters,
  InteractionRecordRow,
  RuntimeOutputFilters,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  TurnResultRecord,
} from "../types.js";

type TurnResultsTable = Table & {
  sessionId: Column;
  turnId: Column;
  createdAt: Column;
};
type RuntimeResultsTable = Table & { sessionId: Column; turnId: Column };
type ToolCallsTable = Table & { sessionId: Column; turnId: Column };
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
  readonly runtimeResults: RuntimeResultsTable;
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
    | "runtimeResultInsert"
    | "toolCallInsert"
    | "runtimeOutputInsert"
    | "interactionRecordInsert"
  >;
}

export type SqlRuntimeRecords = Pick<
  DataStore,
  | "saveTurnResult"
  | "listTurnResults"
  | "setTurnResultCommitStatus"
  | "saveRuntimeResult"
  | "listRuntimeResults"
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
  const {
    turnResults,
    runtimeResults,
    toolCalls,
    runtimeOutputs,
    interactionRecords,
  } = tables;

  return {
    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await runner.insert(turnResults, values.turnResultInsert(record));
    },

    async listTurnResults(
      sessionId: string,
      limit?: number,
    ): Promise<TurnResultRecord[]> {
      const rows = await runner.select<TurnResultRow>(turnResults, {
        where: eq(turnResults.sessionId, sessionId),
        orderBy: [asc(turnResults.createdAt)],
        limit,
      });
      return rows.map((row) => toTurnResultRecord(row, json));
    },

    async setTurnResultCommitStatus(
      sessionId: string,
      turnId: string,
      status: NonNullable<TurnResultRecord["commitStatus"]>,
    ): Promise<void> {
      await runner.update(
        turnResults,
        { commitStatus: status },
        and(
          eq(turnResults.sessionId, sessionId),
          eq(turnResults.turnId, turnId),
        )!,
      );
    },

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      await runner.insert(runtimeResults, values.runtimeResultInsert(record));
    },

    async listRuntimeResults(
      sessionId: string,
      turnId: string,
    ): Promise<RuntimeResultRecord[]> {
      const rows = await runner.select<RuntimeResultRow>(runtimeResults, {
        where: and(
          eq(runtimeResults.sessionId, sessionId),
          eq(runtimeResults.turnId, turnId),
        ),
      });
      return rows.map((row) => toRuntimeResultRecord(row, json));
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
      const rows = await runner.select<ToolCallRow>(toolCalls, { where });
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
        orderBy: [desc(runtimeOutputs.timestamp), desc(runtimeOutputs.id)],
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
