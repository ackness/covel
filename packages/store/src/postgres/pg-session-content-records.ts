import { and, asc, eq } from "drizzle-orm";

import type {
  ApprovalRecord,
  CharacterRecord,
  DataStore,
  EventRecord,
  MessageRecord,
  PaginationOpts,
  PluginConfigRecord,
} from "../types.js";
import type { PgDb } from "./pg-db.js";
import {
  toApprovalRecord,
  toCharacterRecord,
  toEventRecord,
  toMessageRecord,
  toPluginConfigRecord,
} from "./pg-store-mappers.js";
import * as schema from "./schema.js";

export type PgSessionContentRecords = Pick<
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
  | "savePluginConfig"
  | "getPluginConfig"
>;

export function createPgSessionContentRecords(
  getDb: () => PgDb,
): PgSessionContentRecords {
  return {
    async saveEvent(record: EventRecord): Promise<void> {
      await getDb()
        .insert(schema.events)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          type: record.type,
          topic: record.topic,
          payload: record.payload ?? null,
          targetRuntime: record.targetRuntime ?? null,
          turnId: record.turnId ?? null,
          createdAt: record.createdAt,
        });
    },

    async listEvents(
      sessionId: string,
      options?: { topic?: string; limit?: number },
    ): Promise<EventRecord[]> {
      const conditions = [eq(schema.events.sessionId, sessionId)];
      if (options?.topic) {
        conditions.push(eq(schema.events.topic, options.topic));
      }

      const query = getDb()
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(asc(schema.events.createdAt));

      const rows =
        options?.limit != null ? await query.limit(options.limit) : await query;
      return rows.map(toEventRecord);
    },

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await getDb().insert(schema.approvals).values({
        id: record.id,
        sessionId: record.sessionId,
        toolName: record.toolName,
        pluginId: record.pluginId,
        decision: record.decision,
        turnId: record.turnId,
        createdAt: record.createdAt,
      });
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      return rows.map(toApprovalRecord);
    },

    async addMessage(record: MessageRecord): Promise<void> {
      await getDb()
        .insert(schema.messages)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          role: record.role,
          content: record.content,
          metadata: record.metadata ?? null,
          createdAt: record.createdAt,
        });
    },

    async listMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<MessageRecord[]> {
      let query = getDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.sessionId, sessionId))
        .orderBy(asc(schema.messages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toMessageRecord);
    },

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await getDb()
        .insert(schema.characters)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          name: record.name,
          type: record.type,
          description: record.description ?? null,
          fields: record.fields ?? null,
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
            fields: record.fields ?? null,
            version: record.version,
            updatedAt: record.updatedAt,
          },
        });
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.sessionId, sessionId));
      return rows.map(toCharacterRecord);
    },

    async deleteCharacter(sessionId: string, id: string): Promise<void> {
      await getDb()
        .delete(schema.characters)
        .where(
          and(
            eq(schema.characters.sessionId, sessionId),
            eq(schema.characters.id, id),
          ),
        );
    },

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      await getDb()
        .insert(schema.pluginConfigs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          pluginId: record.pluginId,
          config: record.config ?? null,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.pluginConfigs.id,
          set: {
            config: record.config ?? null,
            updatedAt: record.updatedAt,
          },
        });
    },

    async getPluginConfig(
      sessionId: string,
      pluginId: string,
    ): Promise<PluginConfigRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.pluginConfigs)
        .where(
          and(
            eq(schema.pluginConfigs.sessionId, sessionId),
            eq(schema.pluginConfigs.pluginId, pluginId),
          ),
        );
      return rows.length > 0 ? toPluginConfigRecord(rows[0]) : null;
    },
  };
}
