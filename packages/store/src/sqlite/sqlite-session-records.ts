import { and, asc, eq } from "drizzle-orm";

import type {
  ApprovalRecord,
  CharacterRecord,
  DataStore,
  EventRecord,
  MessageRecord,
  PaginationOpts,
  PlayerInputRecord,
  SessionSummaryRecord,
  TraceEventRecord,
  TurnMessageRecord,
} from "../types.js";
import * as schema from "./schema.js";
import {
  toApprovalRecord,
  toCharacterRecord,
  toEventRecord,
  toJson,
  toMessageRecord,
  toPlayerInputRecord,
  toSessionSummaryRecord,
  toTraceEventRecord,
  toTurnMessageRecord,
} from "./sqlite-store-mappers.js";
import type { SqliteDb } from "./sqlite-types.js";

export type SqliteSessionRecords = Pick<
  DataStore,
  | "saveEvent"
  | "listEvents"
  | "saveApproval"
  | "listApprovals"
  | "addMessage"
  | "listMessages"
  | "upsertCharacter"
  | "listCharacters"
  | "deleteCharacter"
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

export function createSqliteSessionRecords(db: SqliteDb): SqliteSessionRecords {
  return {
    async saveEvent(record: EventRecord): Promise<void> {
      db.insert(schema.events)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          type: record.type,
          topic: record.topic,
          payload: record.payload != null ? toJson(record.payload) : null,
          targetRuntime: record.targetRuntime ?? null,
          turnId: record.turnId ?? null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listEvents(
      sessionId: string,
      options?: { topic?: string; limit?: number },
    ): Promise<EventRecord[]> {
      const conditions = [eq(schema.events.sessionId, sessionId)];
      if (options?.topic) {
        conditions.push(eq(schema.events.topic, options.topic));
      }

      const query = db
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(asc(schema.events.createdAt));

      const rows =
        options?.limit != null ? query.limit(options.limit).all() : query.all();
      return rows.map(toEventRecord);
    },

    async saveApproval(record: ApprovalRecord): Promise<void> {
      db.insert(schema.approvals)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          toolName: record.toolName,
          pluginId: record.pluginId,
          decision: record.decision,
          turnId: record.turnId,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      const rows = db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId))
        .all();
      return rows.map(toApprovalRecord);
    },

    async addMessage(record: MessageRecord): Promise<void> {
      db.insert(schema.messages)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          role: record.role,
          content: record.content,
          metadata: record.metadata != null ? toJson(record.metadata) : null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<MessageRecord[]> {
      let query = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.sessionId, sessionId))
        .orderBy(asc(schema.messages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toMessageRecord);
    },

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      db.insert(schema.characters)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          name: record.name,
          type: record.type,
          description: record.description ?? null,
          fields: record.fields != null ? toJson(record.fields) : null,
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.characters.id,
          set: {
            name: record.name,
            type: record.type,
            description: record.description ?? null,
            fields: record.fields != null ? toJson(record.fields) : null,
            version: record.version,
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      const rows = db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.sessionId, sessionId))
        .all();
      return rows.map(toCharacterRecord);
    },

    async deleteCharacter(sessionId: string, id: string): Promise<void> {
      db.delete(schema.characters)
        .where(
          and(
            eq(schema.characters.sessionId, sessionId),
            eq(schema.characters.id, id),
          ),
        )
        .run();
    },

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      db.insert(schema.traceEvents)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          type: record.type,
          traceId: record.traceId,
          turnId: record.turnId,
          payload: record.payload != null ? toJson(record.payload) : null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listTraceEvents(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TraceEventRecord[]> {
      let query = db
        .select()
        .from(schema.traceEvents)
        .where(eq(schema.traceEvents.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toTraceEventRecord);
    },

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

    async listTurnMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<TurnMessageRecord[]> {
      let query = db
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.sessionId, sessionId))
        .orderBy(asc(schema.turnMessages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toTurnMessageRecord);
    },

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      db.insert(schema.playerInputs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          formId: record.formId,
          values: toJson(record.values),
          createdAt: record.createdAt,
        })
        .run();
    },

    async getPlayerInput(
      sessionId: string,
      formId: string,
    ): Promise<PlayerInputRecord | null> {
      const row = db
        .select()
        .from(schema.playerInputs)
        .where(
          and(
            eq(schema.playerInputs.sessionId, sessionId),
            eq(schema.playerInputs.formId, formId),
          ),
        )
        .get();
      return row ? toPlayerInputRecord(row) : null;
    },

    async listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]> {
      const rows = db
        .select()
        .from(schema.playerInputs)
        .where(eq(schema.playerInputs.sessionId, sessionId))
        .all();
      return rows.map(toPlayerInputRecord);
    },

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      db.insert(schema.sessionSummaries)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnRangeStart: record.turnRangeStart,
          turnRangeEnd: record.turnRangeEnd,
          content: record.content,
          focusSections: toJson(record.focusSections),
          createdAt: record.createdAt,
        })
        .run();
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      const rows = db
        .select()
        .from(schema.sessionSummaries)
        .where(eq(schema.sessionSummaries.sessionId, sessionId))
        .all();
      return rows.map(toSessionSummaryRecord);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      db.delete(schema.sessionSummaries)
        .where(eq(schema.sessionSummaries.sessionId, sessionId))
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
