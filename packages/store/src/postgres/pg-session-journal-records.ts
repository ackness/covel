import { and, asc, eq } from "drizzle-orm";

import type {
  DataStore,
  PaginationOpts,
  PlayerInputRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
} from "../types.js";
import type { PgDb } from "./pg-db.js";
import {
  toPlayerInputRecord,
  toSessionSummaryRecord,
  toTraceEventRecord,
  toTurnMessageRecord,
} from "./pg-store-mappers.js";
import * as schema from "./schema.js";

export type PgSessionJournalRecords = Pick<
  DataStore,
  | "addTraceEvent"
  | "listTraceEvents"
  | "appendTurnMessage"
  | "listTurnMessages"
  | "savePlayerInput"
  | "getPlayerInput"
  | "listPlayerInputs"
  | "saveSessionSummary"
  | "listSessionSummaries"
  | "deleteSessionSummaries"
  | "tagTurnMessagesCompacted"
>;

export function createPgSessionJournalRecords(
  getDb: () => PgDb,
): PgSessionJournalRecords {
  return {
    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await getDb()
        .insert(schema.traceEvents)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          type: record.type,
          traceId: record.traceId,
          turnId: record.turnId,
          payload: record.payload ?? null,
          createdAt: record.createdAt,
        });
    },

    async listTraceEvents(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TraceEventRecord[]> {
      let query = getDb()
        .select()
        .from(schema.traceEvents)
        .where(eq(schema.traceEvents.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toTraceEventRecord);
    },

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

    async listTurnMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TurnMessageRecord[]> {
      let query = getDb()
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.sessionId, sessionId))
        .orderBy(asc(schema.turnMessages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toTurnMessageRecord);
    },

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await getDb()
        .insert(schema.playerInputs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          formId: record.formId,
          values: record.values ?? null,
          createdAt: record.createdAt,
        });
    },

    async getPlayerInput(
      sessionId: string,
      formId: string,
    ): Promise<PlayerInputRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.playerInputs)
        .where(
          and(
            eq(schema.playerInputs.sessionId, sessionId),
            eq(schema.playerInputs.formId, formId),
          ),
        );
      return rows.length > 0 ? toPlayerInputRecord(rows[0]) : null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.playerInputs)
        .where(eq(schema.playerInputs.sessionId, sessionId));
      return rows.map(toPlayerInputRecord);
    },

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      await getDb()
        .insert(schema.sessionSummaries)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnRangeStart: record.turnRangeStart,
          turnRangeEnd: record.turnRangeEnd,
          content: record.content,
          focusSections: record.focusSections as string[],
          createdAt: record.createdAt,
        });
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.sessionSummaries)
        .where(eq(schema.sessionSummaries.sessionId, sessionId));
      return rows.map(toSessionSummaryRecord);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      await getDb()
        .delete(schema.sessionSummaries)
        .where(eq(schema.sessionSummaries.sessionId, sessionId));
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
