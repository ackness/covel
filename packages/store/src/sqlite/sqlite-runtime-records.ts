import { and, asc, desc, eq, gte, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
import * as schema from "./schema.js";
import {
  toInteractionRecordRow,
  toRuntimeOutputRecord,
  toRuntimeResultRecord,
  toToolCallRecord,
  toTurnResultRecord,
  toJson,
} from "./sqlite-store-mappers.js";

type SqliteDb = BetterSQLite3Database<typeof schema>;

export type SqliteRuntimeRecords = Pick<
  DataStore,
  | "saveTurnResult"
  | "getTurnResult"
  | "listTurnResults"
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

export function createSqliteRuntimeRecords(db: SqliteDb): SqliteRuntimeRecords {
  return {
    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      db.insert(schema.turnResults)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          runtimeResults: toJson(record.runtimeResults),
          conflicts: record.conflicts != null ? toJson(record.conflicts) : null,
          auditResult:
            record.auditResult != null ? toJson(record.auditResult) : null,
          durationMs: record.durationMs,
          createdAt: record.createdAt,
        })
        .run();
    },

    async getTurnResult(
      sessionId: string,
      turnId: string,
    ): Promise<TurnResultRecord | null> {
      const row = db
        .select()
        .from(schema.turnResults)
        .where(
          and(
            eq(schema.turnResults.sessionId, sessionId),
            eq(schema.turnResults.turnId, turnId),
          ),
        )
        .get();
      return row ? toTurnResultRecord(row) : null;
    },

    async listTurnResults(
      sessionId: string,
      limit?: number,
    ): Promise<TurnResultRecord[]> {
      const query = db
        .select()
        .from(schema.turnResults)
        .where(eq(schema.turnResults.sessionId, sessionId))
        .orderBy(asc(schema.turnResults.createdAt));

      const rows = limit != null ? query.limit(limit).all() : query.all();
      return rows.map(toTurnResultRecord);
    },

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      db.insert(schema.runtimeResults)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          pluginId: record.pluginId,
          runtimeId: record.runtimeId,
          status: record.status,
          output: record.output != null ? toJson(record.output) : null,
          toolCalls: record.toolCalls != null ? toJson(record.toolCalls) : null,
          durationMs: record.durationMs,
          tokenUsage:
            record.tokenUsage != null ? toJson(record.tokenUsage) : null,
          error: record.error ?? null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listRuntimeResults(
      sessionId: string,
      turnId: string,
    ): Promise<RuntimeResultRecord[]> {
      const rows = db
        .select()
        .from(schema.runtimeResults)
        .where(
          and(
            eq(schema.runtimeResults.sessionId, sessionId),
            eq(schema.runtimeResults.turnId, turnId),
          ),
        )
        .all();
      return rows.map(toRuntimeResultRecord);
    },

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      db.insert(schema.toolCalls)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          toolName: record.toolName,
          pluginId: record.pluginId,
          runtimeId: record.runtimeId,
          input: record.input != null ? toJson(record.input) : null,
          output: record.output != null ? toJson(record.output) : null,
          durationMs: record.durationMs,
          approvalStatus: record.approvalStatus,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listToolCalls(
      sessionId: string,
      turnId?: string,
    ): Promise<ToolCallRecordRow[]> {
      const condition =
        turnId != null
          ? and(
              eq(schema.toolCalls.sessionId, sessionId),
              eq(schema.toolCalls.turnId, turnId),
            )
          : eq(schema.toolCalls.sessionId, sessionId);

      const rows = db.select().from(schema.toolCalls).where(condition).all();
      return rows.map(toToolCallRecord);
    },

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      db.insert(schema.runtimeOutputs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          runtimeResultId: record.runtimeResultId ?? null,
          pluginId: record.pluginId,
          runtimeId: record.runtimeId,
          timestamp: record.timestamp,
          results: toJson(record.results ?? []),
          metaData: toJson(record.metaData ?? {}),
          createdAt: record.createdAt,
        })
        .run();
    },

    async getRuntimeOutput(
      sessionId: string,
      id: string,
    ): Promise<RuntimeOutputRecord | null> {
      const rows = db
        .select()
        .from(schema.runtimeOutputs)
        .where(
          and(
            eq(schema.runtimeOutputs.sessionId, sessionId),
            eq(schema.runtimeOutputs.id, id),
          ),
        )
        .limit(1)
        .all();
      return rows[0] ? toRuntimeOutputRecord(rows[0]) : null;
    },

    async listRuntimeOutputs(
      sessionId: string,
      filters?: RuntimeOutputFilters,
    ): Promise<RuntimeOutputRecord[]> {
      const conditions: SQL[] = [
        eq(schema.runtimeOutputs.sessionId, sessionId),
      ];
      if (filters?.runtimeId) {
        conditions.push(eq(schema.runtimeOutputs.runtimeId, filters.runtimeId));
      }
      if (filters?.pluginId) {
        conditions.push(eq(schema.runtimeOutputs.pluginId, filters.pluginId));
      }
      if (filters?.sinceTimestamp) {
        conditions.push(
          gte(schema.runtimeOutputs.timestamp, filters.sinceTimestamp),
        );
      }
      let query = db
        .select()
        .from(schema.runtimeOutputs)
        .where(and(...conditions))
        .orderBy(desc(schema.runtimeOutputs.timestamp))
        .$dynamic();
      if (filters?.limit !== undefined) query = query.limit(filters.limit);
      return query.all().map(toRuntimeOutputRecord);
    },

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      db.insert(schema.interactionRecords)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId ?? null,
          timestamp: record.timestamp,
          source: record.source,
          channel: record.channel,
          type: record.type,
          targetPluginId: record.targetPluginId ?? null,
          targetRuntimeId: record.targetRuntimeId ?? null,
          payload: toJson(record.payload ?? null),
          metaData: record.metaData != null ? toJson(record.metaData) : null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listInteractionRecords(
      sessionId: string,
      filters?: InteractionRecordFilters,
    ): Promise<InteractionRecordRow[]> {
      const conditions: SQL[] = [
        eq(schema.interactionRecords.sessionId, sessionId),
      ];
      if (filters?.type) {
        conditions.push(eq(schema.interactionRecords.type, filters.type));
      }
      if (filters?.source) {
        conditions.push(eq(schema.interactionRecords.source, filters.source));
      }
      if (filters?.targetPluginId) {
        conditions.push(
          eq(schema.interactionRecords.targetPluginId, filters.targetPluginId),
        );
      }
      let query = db
        .select()
        .from(schema.interactionRecords)
        .where(and(...conditions))
        .orderBy(desc(schema.interactionRecords.timestamp))
        .$dynamic();
      if (filters?.limit !== undefined) query = query.limit(filters.limit);
      return query.all().map(toInteractionRecordRow);
    },
  };
}
