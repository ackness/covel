/**
 * SQLite-backed DataStore implementation using Drizzle ORM + better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, asc, desc, gte, type SQL } from 'drizzle-orm';
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
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
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
  toRuntimeOutputRecord,
  toInteractionRecordRow,
  toTurnMessageRecord,
  toPlayerInputRecord,
  toWorkingMemoryRecord,
  toLorebookEntryRecord,
  toSessionSummaryRecord,
  toSuspensionRecord,
  type SuspensionRow,
  toSnapshotRecord,
  type SnapshotRow,
} from './sqlite-store-mappers.js';
import type { VectorStoreCapability, VectorModelOps } from '../vector-store.js';
import { createSqliteVectorCapability } from './sqlite-vector.js';

// ── Factory ─────────────────────────────────────────────────────

export function createSqliteStore(dbPath: string): DataStore & Partial<VectorStoreCapability & VectorModelOps> {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  createTables(sqlite);

  // Attempt to load sqlite-vec. If the optional binary is missing, vector
  // methods are simply absent from the returned store and supportsVector()
  // will return false — callers fall back to structured retrieval.
  const vectorCapability = createSqliteVectorCapability(sqlite);

  // ── Transaction state (S4-T1) ──
  //
  // better-sqlite3 holds a single synchronous connection per Database instance,
  // so we can drive transactions directly via BEGIN / COMMIT / ROLLBACK on the
  // same handle. We track a local boolean to enforce "no nested transactions"
  // and to detect commit/rollback calls without a matching begin.
  let txActive = false;

  const baseStore: DataStore = {
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
          playingTurnOffset: session.playingTurnOffset ?? null,
          runtimeModelOverrides: JSON.stringify(session.runtimeModelOverrides ?? {}),
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
      patch: Partial<Pick<SessionRecord, 'phase' | 'turnCount' | 'activePlugins' | 'updatedAt' | 'embeddingModelId' | 'embeddingLockedAt' | 'playingTurnOffset' | 'runtimeModelOverrides'>>,
    ): Promise<void> {
      const values: Record<string, unknown> = {};
      if (patch.phase !== undefined) values.phase = patch.phase;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.activePlugins !== undefined) values.activePlugins = JSON.stringify(patch.activePlugins);
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ('embeddingModelId' in patch) values.embeddingModelId = patch.embeddingModelId ?? null;
      if ('embeddingLockedAt' in patch) values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      if ('playingTurnOffset' in patch) values.playingTurnOffset = patch.playingTurnOffset ?? null;
      if ('runtimeModelOverrides' in patch) {
        values.runtimeModelOverrides = JSON.stringify(patch.runtimeModelOverrides ?? {});
      }

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
      // Cascade delete all session-scoped child rows within a transaction.
      sqlite.transaction(() => {
        db.delete(schema.turnResults).where(eq(schema.turnResults.sessionId, id)).run();
        db.delete(schema.runtimeResults).where(eq(schema.runtimeResults.sessionId, id)).run();
        db.delete(schema.toolCalls).where(eq(schema.toolCalls.sessionId, id)).run();
        db.delete(schema.stateSchemas).where(eq(schema.stateSchemas.sessionId, id)).run();
        db.delete(schema.stateEntries).where(eq(schema.stateEntries.sessionId, id)).run();
        db.delete(schema.stateChanges).where(eq(schema.stateChanges.sessionId, id)).run();
        db.delete(schema.events).where(eq(schema.events.sessionId, id)).run();
        db.delete(schema.approvals).where(eq(schema.approvals.sessionId, id)).run();
        db.delete(schema.messages).where(eq(schema.messages.sessionId, id)).run();
        db.delete(schema.characters).where(eq(schema.characters.sessionId, id)).run();
        db.delete(schema.pluginData).where(eq(schema.pluginData.sessionId, id)).run();
        db.delete(schema.pluginConfigs).where(eq(schema.pluginConfigs.sessionId, id)).run();
        db.delete(schema.traceEvents).where(eq(schema.traceEvents.sessionId, id)).run();
        db.delete(schema.runtimeOutputs).where(eq(schema.runtimeOutputs.sessionId, id)).run();
        db.delete(schema.interactionRecords).where(eq(schema.interactionRecords.sessionId, id)).run();
        db.delete(schema.turnMessages).where(eq(schema.turnMessages.sessionId, id)).run();
        db.delete(schema.playerInputs).where(eq(schema.playerInputs.sessionId, id)).run();
        db.delete(schema.workingMemory).where(eq(schema.workingMemory.sessionId, id)).run();
        db.delete(schema.lorebookEntries).where(eq(schema.lorebookEntries.sessionId, id)).run();
        db.delete(schema.sessionSummaries).where(eq(schema.sessionSummaries.sessionId, id)).run();
        sqlite.prepare('DELETE FROM suspensions WHERE session_id = ?').run(id);
        sqlite.prepare('DELETE FROM state_snapshots WHERE session_id = ?').run(id);
        db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
      })();
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
          target: [
            schema.stateEntries.sessionId,
            schema.stateEntries.tableName,
            schema.stateEntries.fieldName,
          ],
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

    // ── Runtime Outputs (PR-1) ──────────────────────────────

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

    async getRuntimeOutput(sessionId: string, id: string): Promise<RuntimeOutputRecord | null> {
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
      const conditions: SQL[] = [eq(schema.runtimeOutputs.sessionId, sessionId)];
      if (filters?.runtimeId) {
        conditions.push(eq(schema.runtimeOutputs.runtimeId, filters.runtimeId));
      }
      if (filters?.pluginId) {
        conditions.push(eq(schema.runtimeOutputs.pluginId, filters.pluginId));
      }
      if (filters?.sinceTimestamp) {
        conditions.push(gte(schema.runtimeOutputs.timestamp, filters.sinceTimestamp));
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

    // ── Interaction Records (PR-1) ──────────────────────────

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
      const conditions: SQL[] = [eq(schema.interactionRecords.sessionId, sessionId)];
      if (filters?.type) {
        conditions.push(eq(schema.interactionRecords.type, filters.type));
      }
      if (filters?.source) {
        conditions.push(eq(schema.interactionRecords.source, filters.source));
      }
      if (filters?.targetPluginId) {
        conditions.push(eq(schema.interactionRecords.targetPluginId, filters.targetPluginId));
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

    // ── Working Memory (S3-T3) ───────────────────────────────

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      db.insert(schema.workingMemory)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          key: record.key,
          scope: record.scope,
          value: toJson(record.value),
          schemaRef: record.schemaRef ?? null,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.workingMemory.sessionId,
            schema.workingMemory.scope,
            schema.workingMemory.key,
          ],
          set: {
            id: record.id,
            value: toJson(record.value),
            schemaRef: record.schemaRef ?? null,
            updatedAt: record.updatedAt,
          },
        })
        .run();
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const rows = db
        .select()
        .from(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        )
        .all();
      return rows.length > 0 ? toWorkingMemoryRecord(rows[0]) : null;
    },

    async listWorkingMemory(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
      const rows = db
        .select()
        .from(schema.workingMemory)
        .where(eq(schema.workingMemory.sessionId, sessionId))
        .orderBy(asc(schema.workingMemory.scope), asc(schema.workingMemory.key))
        .all();
      return rows.map(toWorkingMemoryRecord);
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<void> {
      db.delete(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        )
        .run();
    },

    // ── Lorebook Entries (S3-T2) ─────────────────────────────

    async upsertLorebookEntries(records: readonly LorebookEntryRecord[]): Promise<void> {
      if (records.length === 0) return;
      // Drizzle's better-sqlite3 driver does not yet expose a multi-row
      // onConflictDoUpdate that updates per-row in one round trip, so we
      // upsert one row at a time inside an implicit BEGIN to keep it
      // atomic. Volumes are small (a handful of entries per world).
      for (const r of records) {
        db.insert(schema.lorebookEntries)
          .values({
            id: r.id,
            sessionId: r.sessionId,
            pluginId: r.pluginId,
            keys: toJson(r.keys),
            content: r.content,
            strategy: r.strategy,
            position: r.position,
            insertionOrder: r.insertionOrder,
            enabled: r.enabled ? 1 : 0,
            extra: r.extra === undefined ? null : toJson(r.extra),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })
          .onConflictDoUpdate({
            target: schema.lorebookEntries.id,
            set: {
              sessionId: r.sessionId,
              pluginId: r.pluginId,
              keys: toJson(r.keys),
              content: r.content,
              strategy: r.strategy,
              position: r.position,
              insertionOrder: r.insertionOrder,
              enabled: r.enabled ? 1 : 0,
              extra: r.extra === undefined ? null : toJson(r.extra),
              updatedAt: r.updatedAt,
            },
          })
          .run();
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const rows = db
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.sessionId, sessionId))
        .orderBy(asc(schema.lorebookEntries.insertionOrder), asc(schema.lorebookEntries.id))
        .all();
      return rows.map(toLorebookEntryRecord);
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      db.delete(schema.lorebookEntries)
        .where(
          and(
            eq(schema.lorebookEntries.sessionId, sessionId),
            eq(schema.lorebookEntries.id, id),
          ),
        )
        .run();
    },

    // ── Session Summaries (S2-T2 Compactor) ──────────────────

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

    async listSessionSummaries(sessionId: string): Promise<readonly SessionSummaryRecord[]> {
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

    // ── Suspensions (S4-T4) ─────────────────────────────────

    async saveSuspension(record: SuspensionRecord): Promise<void> {
      sqlite.prepare(
        `INSERT INTO suspensions (id, session_id, turn_id, runtime_id, plugin_id, reason, resume_schema, pending_continuation, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason,
           resume_schema = excluded.resume_schema,
           pending_continuation = excluded.pending_continuation,
           resolved_at = excluded.resolved_at`,
      ).run(
        record.id,
        record.sessionId,
        record.turnId,
        record.runtimeId,
        record.pluginId,
        record.reason,
        toJson(record.resumeSchema),
        toJson(record.pendingContinuation),
        record.createdAt,
        record.resolvedAt ?? null,
      );
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      const row = sqlite.prepare('SELECT * FROM suspensions WHERE id = ?').get(id) as SuspensionRow | undefined;
      return row ? toSuspensionRecord(row) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      sqlite.prepare('UPDATE suspensions SET resolved_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      );
    },

    async listSuspensions(sessionId: string): Promise<readonly SuspensionRecord[]> {
      const rows = sqlite.prepare('SELECT * FROM suspensions WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as SuspensionRow[];
      return rows.map(toSuspensionRecord);
    },

    async deleteSuspension(id: string): Promise<void> {
      sqlite.prepare('DELETE FROM suspensions WHERE id = ?').run(id);
    },

    // ── Snapshots (S4-T2) ─────────────────────────────────────

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      sqlite.prepare(
        `INSERT INTO state_snapshots (id, session_id, turn_id, kind, parent_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           turn_id = excluded.turn_id,
           kind = excluded.kind,
           parent_id = excluded.parent_id,
           payload = excluded.payload`,
      ).run(
        record.id,
        record.sessionId,
        record.turnId,
        record.kind,
        record.parentId ?? null,
        toJson(record.payload),
        record.createdAt,
      );
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      const row = sqlite.prepare('SELECT * FROM state_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
      return row ? toSnapshotRecord(row) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = sqlite
        .prepare('SELECT * FROM state_snapshots WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as SnapshotRow[];
      return rows.map(toSnapshotRecord);
    },

    async deleteSnapshot(id: string): Promise<void> {
      sqlite.prepare('DELETE FROM state_snapshots WHERE id = ?').run(id);
    },

    // ── Transactions (S4-T1) ──────────────────────────────────

    async beginTx(): Promise<void> {
      if (txActive) {
        throw new Error('SqliteStore: nested transactions are not supported (beginTx called while another tx is active)');
      }
      sqlite.exec('BEGIN');
      txActive = true;
    },

    async commitTx(): Promise<void> {
      if (!txActive) {
        throw new Error('SqliteStore: commitTx called without an active transaction');
      }
      // Reset the flag in finally so a throwing COMMIT still clears state;
      // the next beginTx can then recover instead of reporting a phantom active tx.
      try {
        sqlite.exec('COMMIT');
      } finally {
        txActive = false;
      }
    },

    async rollbackTx(): Promise<void> {
      if (!txActive) {
        throw new Error('SqliteStore: rollbackTx called without an active transaction');
      }
      try {
        sqlite.exec('ROLLBACK');
      } finally {
        txActive = false;
      }
    },

    // ── Lifecycle ────────────────────────────────────────────

    async close(): Promise<void> {
      sqlite.close();
    },
  };

  // Compose the optional vector capability onto the base store. When
  // sqlite-vec could not be loaded, the returned store has no vector
  // methods and `supportsVector(store)` returns false.
  if (vectorCapability) {
    return Object.assign(baseStore, vectorCapability);
  }
  return baseStore;
}
