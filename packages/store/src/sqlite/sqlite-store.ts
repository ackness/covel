/**
 * SQLite-backed DataStore implementation using Drizzle ORM + better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, asc } from 'drizzle-orm';
import * as schema from './schema.js';
import type {
  DataStore,
  PaginationOpts,
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginDataRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  TurnMessageRecord,
  PlayerInputRecord,
} from '../types.js';
import {
  toJson,
  fromJson,
  fromJsonRequired,
  createTables,
  toSessionRecord,
  toWorldRecord,
  toTurnResultRecord,
  toRuntimeResultRecord,
  toToolCallRecord,
  toStateSchemaRecord,
  toStateEntryRecord,
  toStateChangeRecord,
  toEventRecord,
  toApprovalRecord,
  toMessageRecord,
  toCharacterRecord,
  toPluginDataRecord,
  toPluginConfigRecord,
  toTraceEventRecord,
  toTurnMessageRecord,
  toPlayerInputRecord,
} from './sqlite-store-mappers.js';

// ── Factory ─────────────────────────────────────────────────────

export function createSqliteStore(dbPath: string): DataStore {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  createTables(sqlite);

  return {
    // ── Session ──────────────────────────────────────────────

    async createSession(session: SessionRecord): Promise<void> {
      db.insert(schema.sessions)
        .values({
          id: session.id,
          worldId: session.worldId ?? null,
          phase: session.phase,
          turnCount: session.turnCount,
          locale: session.locale,
          activePlugins: JSON.stringify(session.activePlugins),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })
        .run();
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const row = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get();
      return row ? toSessionRecord(row) : null;
    },

    async updateSession(
      id: string,
      patch: Partial<Pick<SessionRecord, 'phase' | 'turnCount' | 'activePlugins' | 'updatedAt'>>,
    ): Promise<void> {
      const values: Record<string, unknown> = {};
      if (patch.phase !== undefined) values.phase = patch.phase;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.activePlugins !== undefined) values.activePlugins = JSON.stringify(patch.activePlugins);
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;

      if (Object.keys(values).length > 0) {
        db.update(schema.sessions)
          .set(values)
          .where(eq(schema.sessions.id, id))
          .run();
      }
    },

    async listSessions(): Promise<SessionRecord[]> {
      const rows = db.select().from(schema.sessions).all();
      return rows.map(toSessionRecord);
    },

    async deleteSession(id: string): Promise<void> {
      db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
    },

    // ── Turn Results ─────────────────────────────────────────

    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      db.insert(schema.turnResults)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          runtimeResults: toJson(record.runtimeResults),
          conflicts: record.conflicts != null ? toJson(record.conflicts) : null,
          auditResult: record.auditResult != null ? toJson(record.auditResult) : null,
          durationMs: record.durationMs,
          createdAt: record.createdAt,
        })
        .run();
    },

    async getTurnResult(sessionId: string, turnId: string): Promise<TurnResultRecord | null> {
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

    async listTurnResults(sessionId: string, limit?: number): Promise<TurnResultRecord[]> {
      let query = db
        .select()
        .from(schema.turnResults)
        .where(eq(schema.turnResults.sessionId, sessionId))
        .orderBy(asc(schema.turnResults.createdAt));

      const rows = limit != null ? query.limit(limit).all() : query.all();
      return rows.map(toTurnResultRecord);
    },

    // ── Runtime Results ──────────────────────────────────────

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
          tokenUsage: record.tokenUsage != null ? toJson(record.tokenUsage) : null,
          error: record.error ?? null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listRuntimeResults(sessionId: string, turnId: string): Promise<RuntimeResultRecord[]> {
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

    // ── Tool Calls ───────────────────────────────────────────

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

    async listToolCalls(sessionId: string, turnId?: string): Promise<ToolCallRecordRow[]> {
      const condition = turnId != null
        ? and(
            eq(schema.toolCalls.sessionId, sessionId),
            eq(schema.toolCalls.turnId, turnId),
          )
        : eq(schema.toolCalls.sessionId, sessionId);

      const rows = db
        .select()
        .from(schema.toolCalls)
        .where(condition)
        .all();
      return rows.map(toToolCallRecord);
    },

    // ── State Schemas ────────────────────────────────────────

    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      db.insert(schema.stateSchemas)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          schema: toJson(record.schema),
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSchemas.id,
          set: {
            schema: toJson(record.schema),
          },
        })
        .run();
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      const rows = db
        .select()
        .from(schema.stateSchemas)
        .where(eq(schema.stateSchemas.sessionId, sessionId))
        .all();
      return rows.map(toStateSchemaRecord);
    },

    async deleteStateSchema(sessionId: string, tableName: string): Promise<void> {
      db.delete(schema.stateSchemas)
        .where(
          and(
            eq(schema.stateSchemas.sessionId, sessionId),
            eq(schema.stateSchemas.tableName, tableName),
          ),
        )
        .run();
    },

    // ── State Entries ────────────────────────────────────────

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const row = db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
            eq(schema.stateEntries.fieldName, fieldName),
          ),
        )
        .get();
      return row ? toStateEntryRecord(row) : null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      db.insert(schema.stateEntries)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          fieldName: record.fieldName,
          value: record.value != null ? toJson(record.value) : null,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.stateEntries.id,
          set: {
            value: record.value != null ? toJson(record.value) : null,
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async listStateEntries(sessionId: string, tableName: string): Promise<StateEntryRecord[]> {
      const rows = db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
          ),
        )
        .all();
      return rows.map(toStateEntryRecord);
    },

    // ── State Changes ────────────────────────────────────────

    async addStateChange(record: StateChangeRecord): Promise<void> {
      db.insert(schema.stateChanges)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          fieldName: record.fieldName,
          value: record.value != null ? toJson(record.value) : null,
          changedBy: record.changedBy,
          turnId: record.turnId,
          reason: record.reason ?? null,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const rows = db
        .select()
        .from(schema.stateChanges)
        .where(
          and(
            eq(schema.stateChanges.sessionId, sessionId),
            eq(schema.stateChanges.tableName, tableName),
            eq(schema.stateChanges.fieldName, fieldName),
          ),
        )
        .all();
      return rows.map(toStateChangeRecord);
    },

    // ── Events ───────────────────────────────────────────────

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

      let query = db
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(asc(schema.events.createdAt));

      const rows = options?.limit != null ? query.limit(options.limit).all() : query.all();
      return rows.map(toEventRecord);
    },

    // ── Approvals ────────────────────────────────────────────

    async saveApproval(record: ApprovalRecord): Promise<void> {
      db.insert(schema.approvals)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          toolName: record.toolName,
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

    // ── Messages ─────────────────────────────────────────────

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

    async listMessages(sessionId: string, pagination?: PaginationOpts): Promise<MessageRecord[]> {
      let query = db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.sessionId, sessionId))
        .orderBy(asc(schema.messages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined) query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toMessageRecord);
    },

    // ── Characters ───────────────────────────────────────────

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

    // ── Plugin Data ──────────────────────────────────────────

    async setPluginData(record: PluginDataRecord): Promise<void> {
      db.insert(schema.pluginData)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          pluginId: record.pluginId,
          namespace: record.namespace,
          key: record.key,
          value: record.value != null ? toJson(record.value) : null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.pluginData.sessionId,
            schema.pluginData.pluginId,
            schema.pluginData.namespace,
            schema.pluginData.key,
          ],
          set: {
            value: record.value != null ? toJson(record.value) : null,
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void> {
      if (records.length === 0) return;
      db.transaction((tx) => {
        for (const record of records) {
          tx.insert(schema.pluginData)
            .values({
              id: record.id,
              sessionId: record.sessionId,
              pluginId: record.pluginId,
              namespace: record.namespace,
              key: record.key,
              value: record.value != null ? toJson(record.value) : null,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                schema.pluginData.sessionId,
                schema.pluginData.pluginId,
                schema.pluginData.namespace,
                schema.pluginData.key,
              ],
              set: {
                value: record.value != null ? toJson(record.value) : null,
                updatedAt: record.updatedAt,
              },
            })
            .run();
        }
      });
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const row = db
        .select()
        .from(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        )
        .get();
      return row ? toPluginDataRecord(row) : null;
    },

    async listPluginData(
      sessionId: string,
      pluginId: string,
      namespace?: string,
      pagination?: PaginationOpts,
    ): Promise<PluginDataRecord[]> {
      const conditions = [
        eq(schema.pluginData.sessionId, sessionId),
        eq(schema.pluginData.pluginId, pluginId),
      ];
      if (namespace != null) {
        conditions.push(eq(schema.pluginData.namespace, namespace));
      }

      let query = db
        .select()
        .from(schema.pluginData)
        .where(and(...conditions))
        .$dynamic();
      if (pagination?.limit !== undefined) query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toPluginDataRecord);
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      db.delete(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        )
        .run();
    },

    // ── Plugin Configs ───────────────────────────────────────

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      db.insert(schema.pluginConfigs)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          pluginId: record.pluginId,
          config: toJson(record.config),
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.pluginConfigs.id,
          set: {
            config: toJson(record.config),
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async getPluginConfig(
      sessionId: string,
      pluginId: string,
    ): Promise<PluginConfigRecord | null> {
      const row = db
        .select()
        .from(schema.pluginConfigs)
        .where(
          and(
            eq(schema.pluginConfigs.sessionId, sessionId),
            eq(schema.pluginConfigs.pluginId, pluginId),
          ),
        )
        .get();
      return row ? toPluginConfigRecord(row) : null;
    },

    // ── Worlds ───────────────────────────────────────────────

    async listWorlds(): Promise<WorldRecord[]> {
      const rows = db.select().from(schema.worlds).all();
      return rows.map(toWorldRecord);
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const row = db
        .select()
        .from(schema.worlds)
        .where(eq(schema.worlds.id, id))
        .get();
      return row ? toWorldRecord(row) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      db.insert(schema.worlds)
        .values({
          id: record.id,
          name: record.name,
          description: record.description,
          lore: record.lore ?? null,
          tags: record.tags != null ? toJson(record.tags) : null,
          locale: record.locale ?? null,
          metadata: record.metadata != null ? toJson(record.metadata) : null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.worlds.id,
          set: {
            name: record.name,
            description: record.description,
            lore: record.lore ?? null,
            tags: record.tags != null ? toJson(record.tags) : null,
            locale: record.locale ?? null,
            metadata: record.metadata != null ? toJson(record.metadata) : null,
            updatedAt: record.updatedAt ?? null,
          },
        })
        .run();
    },

    // ── Trace Events ─────────────────────────────────────────

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

    async listTraceEvents(sessionId: string, pagination?: PaginationOpts): Promise<TraceEventRecord[]> {
      let query = db
        .select()
        .from(schema.traceEvents)
        .where(eq(schema.traceEvents.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined) query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toTraceEventRecord);
    },

    // ── Turn Messages ───────────────────────────────────────

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
          pendingInput: record.pendingInput != null ? toJson(record.pendingInput) : null,
          order: record.order,
          createdAt: record.createdAt,
        })
        .run();
    },

    async listTurnMessages(sessionId: string, pagination?: PaginationOpts): Promise<TurnMessageRecord[]> {
      let query = db
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.sessionId, sessionId))
        .orderBy(asc(schema.turnMessages.createdAt))
        .$dynamic();
      if (pagination?.limit !== undefined) query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toTurnMessageRecord);
    },

    // ── Player Inputs ───────────────────────────────────────

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

    async getPlayerInput(sessionId: string, formId: string): Promise<PlayerInputRecord | null> {
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

    // ── Lifecycle ────────────────────────────────────────────

    async close(): Promise<void> {
      sqlite.close();
    },
  };
}
