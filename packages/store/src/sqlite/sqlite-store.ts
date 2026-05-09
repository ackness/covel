/**
 * SQLite-backed DataStore implementation using Drizzle ORM + better-sqlite3.
 *
 * All operations are synchronous under the hood (better-sqlite3 is sync),
 * but wrapped in Promises to satisfy the async DataStore interface.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { eq, and, asc, desc, gte, type SQL } from "drizzle-orm";
import * as schema from "./schema.js";
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
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
  TurnMessageRecord,
  PlayerInputRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
} from "../types.js";
import { mergeSessionPatch } from "../types.js";
import {
  toJson,
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
  toPluginConfigRecord,
  toTraceEventRecord,
  toRuntimeOutputRecord,
  toInteractionRecordRow,
  toTurnMessageRecord,
  toPlayerInputRecord,
  toSessionSummaryRecord,
  toSuspensionRecord,
  type SuspensionRow,
  toSnapshotRecord,
  type SnapshotRow,
} from "./sqlite-store-mappers.js";
import {
  sqliteStateEntryInsert,
  sqliteStateEntryUpdate,
  sqliteWorldInsert,
  sqliteWorldUpdate,
} from "./sqlite-store-values.js";
import { deleteSqliteSessionCascade } from "./sqlite-session-cascade.js";
import { createSqliteDataCrud } from "./sqlite-data-crud.js";
import type { VectorStoreCapability, VectorModelOps } from "../vector-store.js";
import { createSqliteVectorCapability } from "./sqlite-vector.js";

// ── Factory ─────────────────────────────────────────────────────

export function createSqliteStore(
  dbPath: string,
): DataStore & Partial<VectorStoreCapability & VectorModelOps> {
  // Ensure the parent directory exists. Without this, a fresh checkout that
  // points STORE_BACKEND=sqlite at the default `./data/covel.db` path will
  // crash on boot because better-sqlite3 refuses to open a file in a
  // non-existent directory. This is cheap and idempotent.
  const dir = dirname(dbPath);
  if (dir && dir !== "." && dir !== ":memory:") {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Fall through — better-sqlite3 will produce a clearer error if the
      // path is truly invalid.
    }
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

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
          status: session.status,
          turnCount: session.turnCount,
          preGameCompleted: JSON.stringify(session.preGameCompleted ?? []),
          locale: session.locale,
          activePlugins: JSON.stringify(session.activePlugins),
          metadata: session.metadata != null ? toJson(session.metadata) : null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          runtimeModelOverrides: JSON.stringify(
            session.runtimeModelOverrides ?? {},
          ),
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
      patch: Partial<
        Pick<
          SessionRecord,
          | "status"
          | "turnCount"
          | "preGameCompleted"
          | "activePlugins"
          | "presetId"
          | "updatedAt"
          | "metadata"
          | "embeddingModelId"
          | "embeddingLockedAt"
          | "runtimeModelOverrides"
        >
      >,
    ): Promise<void> {
      const rows = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id));
      const existingRow = rows.get();
      if (!existingRow) return;
      const mergedSession = mergeSessionPatch(
        toSessionRecord(existingRow),
        patch,
      );
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.preGameCompleted !== undefined)
        values.preGameCompleted = JSON.stringify(patch.preGameCompleted);
      if (patch.activePlugins !== undefined)
        values.activePlugins = JSON.stringify(patch.activePlugins);
      if ("metadata" in patch || "presetId" in patch) {
        values.metadata =
          mergedSession.metadata != null
            ? toJson(mergedSession.metadata)
            : null;
      }
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ("embeddingModelId" in patch)
        values.embeddingModelId = patch.embeddingModelId ?? null;
      if ("embeddingLockedAt" in patch)
        values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      if ("runtimeModelOverrides" in patch) {
        values.runtimeModelOverrides = JSON.stringify(
          patch.runtimeModelOverrides ?? {},
        );
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
      deleteSqliteSessionCascade(sqlite, db, id);
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

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
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
        .values(sqliteStateEntryInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.stateEntries.sessionId,
            schema.stateEntries.tableName,
            schema.stateEntries.fieldName,
          ],
          set: sqliteStateEntryUpdate(record),
        })
        .run();
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
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
          value: toJson(record.value),
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

      const rows =
        options?.limit != null ? query.limit(options.limit).all() : query.all();
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

    ...createSqliteDataCrud(db),

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
        .values(sqliteWorldInsert(record))
        .onConflictDoUpdate({
          target: schema.worlds.id,
          set: sqliteWorldUpdate(record),
        })
        .run();
    },

    async deleteWorld(id: string): Promise<void> {
      db.delete(schema.worlds).where(eq(schema.worlds.id, id)).run();
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

    // ── Suspensions (S4-T4) ─────────────────────────────────

    async saveSuspension(record: SuspensionRecord): Promise<void> {
      sqlite
        .prepare(
          `INSERT INTO suspensions (id, session_id, turn_id, runtime_id, plugin_id, reason, resume_schema, pending_continuation, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason,
           resume_schema = excluded.resume_schema,
           pending_continuation = excluded.pending_continuation,
           resolved_at = excluded.resolved_at`,
        )
        .run(
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
      const row = sqlite
        .prepare("SELECT * FROM suspensions WHERE id = ?")
        .get(id) as SuspensionRow | undefined;
      return row ? toSuspensionRecord(row) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      sqlite
        .prepare("UPDATE suspensions SET resolved_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    },

    async claimSuspension(id: string): Promise<boolean> {
      // Atomic compare-and-swap: SQLite executes a single UPDATE as a
      // serialized write, so two concurrent claims cannot both succeed. The
      // WHERE clause only matches unresolved rows; `result.changes` is 1 iff
      // this caller actually transitioned the row. Use a sentinel
      // `claimed:<iso>` so a later `markSuspensionResolved` overwrites it.
      const result = sqlite
        .prepare(
          "UPDATE suspensions SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL",
        )
        .run(`claimed:${new Date().toISOString()}`, id);
      return result.changes === 1;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const rows = sqlite
        .prepare(
          "SELECT * FROM suspensions WHERE session_id = ? ORDER BY created_at ASC",
        )
        .all(sessionId) as SuspensionRow[];
      return rows.map(toSuspensionRecord);
    },

    async deleteSuspension(id: string): Promise<void> {
      sqlite.prepare("DELETE FROM suspensions WHERE id = ?").run(id);
    },

    // ── Snapshots (S4-T2) ─────────────────────────────────────

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      sqlite
        .prepare(
          `INSERT INTO state_snapshots (id, session_id, turn_id, kind, parent_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           turn_id = excluded.turn_id,
           kind = excluded.kind,
           parent_id = excluded.parent_id,
           payload = excluded.payload`,
        )
        .run(
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
      const row = sqlite
        .prepare("SELECT * FROM state_snapshots WHERE id = ?")
        .get(id) as SnapshotRow | undefined;
      return row ? toSnapshotRecord(row) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = sqlite
        .prepare(
          "SELECT * FROM state_snapshots WHERE session_id = ? ORDER BY created_at ASC",
        )
        .all(sessionId) as SnapshotRow[];
      return rows.map(toSnapshotRecord);
    },

    async deleteSnapshot(id: string): Promise<void> {
      sqlite.prepare("DELETE FROM state_snapshots WHERE id = ?").run(id);
    },

    // ── Transactions (S4-T1) ──────────────────────────────────

    async beginTx(): Promise<void> {
      if (txActive) {
        throw new Error(
          "SqliteStore: nested transactions are not supported (beginTx called while another tx is active)",
        );
      }
      sqlite.exec("BEGIN");
      txActive = true;
    },

    async commitTx(): Promise<void> {
      if (!txActive) {
        throw new Error(
          "SqliteStore: commitTx called without an active transaction",
        );
      }
      // Reset the flag in finally so a throwing COMMIT still clears state;
      // the next beginTx can then recover instead of reporting a phantom active tx.
      try {
        sqlite.exec("COMMIT");
      } finally {
        txActive = false;
      }
    },

    async rollbackTx(): Promise<void> {
      if (!txActive) {
        throw new Error(
          "SqliteStore: rollbackTx called without an active transaction",
        );
      }
      try {
        sqlite.exec("ROLLBACK");
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
