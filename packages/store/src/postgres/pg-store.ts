/**
 * PostgreSQL-backed DataStore implementation using Drizzle ORM + postgres.js.
 *
 * All operations are truly async (unlike better-sqlite3).
 * JSON fields use native `jsonb` — no manual stringify/parse needed.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, asc, desc, gte, isNull, type SQL } from "drizzle-orm";
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
} from "../types.js";
import { createPgTxAdapter } from "./pg-store-tx.js";
import {
  CREATE_TABLES_SQL,
  DROP_ALL_SQL,
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
  toSnapshotRecord,
} from "./pg-store-mappers.js";
import type { VectorStoreCapability, VectorModelOps } from "../vector-store.js";
import { createPgVectorCapability } from "./pg-vector.js";

// ── Factory ─────────────────────────────────────────────────────

export interface PgStoreOptions {
  /** Drop and recreate all tables (for test isolation). Default: false. */
  readonly freshSchema?: boolean;
}

export async function createPgStore(
  databaseUrl: string,
  options?: PgStoreOptions,
): Promise<DataStore & VectorStoreCapability & VectorModelOps> {
  const client = postgres(databaseUrl);
  const pooledDb = drizzle(client, { schema });

  if (options?.freshSchema) {
    await client.unsafe(DROP_ALL_SQL);
  }

  // Create tables (idempotent). The pgvector extension is enabled lazily
  // by pg-vector.ts on first vector operation — that keeps stores that
  // never touch RAG (e.g. test fixtures, vector-disabled deployments)
  // bootable on plain postgres.
  await client.unsafe(CREATE_TABLES_SQL);

  // Mutable "current db" handle. Outside a transaction this is the pool-bound
  // drizzle instance; inside one the tx adapter swaps it for the drizzle tx
  // handle so every data method below routes through the active transaction.
  // See pg-store-tx.ts for the callback → imperative adapter details.
  let db: typeof pooledDb = pooledDb;
  const txAdapter = createPgTxAdapter({
    pooledDb,
    setDb: (next) => {
      db = next;
    },
  });

  const baseStore: DataStore = {
    // ── Session ──────────────────────────────────────────────

    async createSession(session: SessionRecord): Promise<void> {
      await db.insert(schema.sessions).values({
        id: session.id,
        worldId: session.worldId ?? null,
        status: session.status,
        turnCount: session.turnCount,
        preGameCompleted: session.preGameCompleted as string[],
        locale: session.locale,
        activePlugins: session.activePlugins as string[],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        runtimeModelOverrides: (session.runtimeModelOverrides ?? {}) as Record<
          string,
          string
        >,
      });
    },

    async getSession(id: string): Promise<SessionRecord | null> {
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id));
      return rows.length > 0 ? toSessionRecord(rows[0]) : null;
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
          | "updatedAt"
          | "embeddingModelId"
          | "embeddingLockedAt"
          | "runtimeModelOverrides"
        >
      >,
    ): Promise<void> {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.preGameCompleted !== undefined)
        values.preGameCompleted = patch.preGameCompleted as string[];
      if (patch.activePlugins !== undefined)
        values.activePlugins = patch.activePlugins as string[];
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ("embeddingModelId" in patch)
        values.embeddingModelId = patch.embeddingModelId ?? null;
      if ("embeddingLockedAt" in patch)
        values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      if ("runtimeModelOverrides" in patch) {
        values.runtimeModelOverrides = (patch.runtimeModelOverrides ??
          {}) as Record<string, string>;
      }

      if (Object.keys(values).length > 0) {
        await db
          .update(schema.sessions)
          .set(values)
          .where(eq(schema.sessions.id, id));
      }
    },

    async listSessions(): Promise<SessionRecord[]> {
      const rows = await db.select().from(schema.sessions);
      return rows.map(toSessionRecord);
    },

    async deleteSession(id: string): Promise<void> {
      await db.transaction(async (tx) => {
        // Delete all session-scoped child rows before removing the session itself.
        await tx
          .delete(schema.turnResults)
          .where(eq(schema.turnResults.sessionId, id));
        await tx
          .delete(schema.runtimeResults)
          .where(eq(schema.runtimeResults.sessionId, id));
        await tx
          .delete(schema.toolCalls)
          .where(eq(schema.toolCalls.sessionId, id));
        await tx
          .delete(schema.stateSchemas)
          .where(eq(schema.stateSchemas.sessionId, id));
        await tx
          .delete(schema.stateEntries)
          .where(eq(schema.stateEntries.sessionId, id));
        await tx
          .delete(schema.stateChanges)
          .where(eq(schema.stateChanges.sessionId, id));
        await tx.delete(schema.events).where(eq(schema.events.sessionId, id));
        await tx
          .delete(schema.approvals)
          .where(eq(schema.approvals.sessionId, id));
        await tx
          .delete(schema.messages)
          .where(eq(schema.messages.sessionId, id));
        await tx
          .delete(schema.characters)
          .where(eq(schema.characters.sessionId, id));
        await tx
          .delete(schema.pluginData)
          .where(eq(schema.pluginData.sessionId, id));
        await tx
          .delete(schema.pluginConfigs)
          .where(eq(schema.pluginConfigs.sessionId, id));
        await tx
          .delete(schema.traceEvents)
          .where(eq(schema.traceEvents.sessionId, id));
        await tx
          .delete(schema.runtimeOutputs)
          .where(eq(schema.runtimeOutputs.sessionId, id));
        await tx
          .delete(schema.interactionRecords)
          .where(eq(schema.interactionRecords.sessionId, id));
        await tx
          .delete(schema.turnMessages)
          .where(eq(schema.turnMessages.sessionId, id));
        await tx
          .delete(schema.playerInputs)
          .where(eq(schema.playerInputs.sessionId, id));
        await tx
          .delete(schema.workingMemory)
          .where(eq(schema.workingMemory.sessionId, id));
        await tx
          .delete(schema.lorebookEntries)
          .where(eq(schema.lorebookEntries.sessionId, id));
        await tx
          .delete(schema.sessionSummaries)
          .where(eq(schema.sessionSummaries.sessionId, id));
        await tx
          .delete(schema.suspensions)
          .where(eq(schema.suspensions.sessionId, id));
        await tx
          .delete(schema.stateSnapshots)
          .where(eq(schema.stateSnapshots.sessionId, id));
        await tx.delete(schema.sessions).where(eq(schema.sessions.id, id));
      });
    },

    // ── Turn Results ─────────────────────────────────────────

    async saveTurnResult(record: TurnResultRecord): Promise<void> {
      await db.insert(schema.turnResults).values({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        runtimeResults: record.runtimeResults ?? null,
        conflicts: record.conflicts ?? null,
        auditResult: record.auditResult ?? null,
        durationMs: record.durationMs,
        createdAt: record.createdAt,
      });
    },

    async getTurnResult(
      sessionId: string,
      turnId: string,
    ): Promise<TurnResultRecord | null> {
      const rows = await db
        .select()
        .from(schema.turnResults)
        .where(
          and(
            eq(schema.turnResults.sessionId, sessionId),
            eq(schema.turnResults.turnId, turnId),
          ),
        );
      return rows.length > 0 ? toTurnResultRecord(rows[0]) : null;
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

      const rows = limit != null ? await query.limit(limit) : await query;
      return rows.map(toTurnResultRecord);
    },

    // ── Runtime Results ──────────────────────────────────────

    async saveRuntimeResult(record: RuntimeResultRecord): Promise<void> {
      await db.insert(schema.runtimeResults).values({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        status: record.status,
        output: record.output ?? null,
        toolCalls: record.toolCalls ?? null,
        durationMs: record.durationMs,
        tokenUsage: record.tokenUsage ?? null,
        error: record.error ?? null,
        createdAt: record.createdAt,
      });
    },

    async listRuntimeResults(
      sessionId: string,
      turnId: string,
    ): Promise<RuntimeResultRecord[]> {
      const rows = await db
        .select()
        .from(schema.runtimeResults)
        .where(
          and(
            eq(schema.runtimeResults.sessionId, sessionId),
            eq(schema.runtimeResults.turnId, turnId),
          ),
        );
      return rows.map(toRuntimeResultRecord);
    },

    // ── Tool Calls ───────────────────────────────────────────

    async saveToolCall(record: ToolCallRecordRow): Promise<void> {
      await db.insert(schema.toolCalls).values({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        toolName: record.toolName,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        input: record.input ?? null,
        output: record.output ?? null,
        durationMs: record.durationMs,
        approvalStatus: record.approvalStatus,
        createdAt: record.createdAt,
      });
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

      const rows = await db.select().from(schema.toolCalls).where(condition);
      return rows.map(toToolCallRecord);
    },

    // ── State Schemas ────────────────────────────────────────

    async saveStateSchema(record: StateSchemaRecord): Promise<void> {
      await db
        .insert(schema.stateSchemas)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          schema: record.schema ?? null,
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSchemas.id,
          set: {
            schema: record.schema ?? null,
          },
        });
    },

    async listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]> {
      const rows = await db
        .select()
        .from(schema.stateSchemas)
        .where(eq(schema.stateSchemas.sessionId, sessionId));
      return rows.map(toStateSchemaRecord);
    },

    async deleteStateSchema(
      sessionId: string,
      tableName: string,
    ): Promise<void> {
      await db
        .delete(schema.stateSchemas)
        .where(
          and(
            eq(schema.stateSchemas.sessionId, sessionId),
            eq(schema.stateSchemas.tableName, tableName),
          ),
        );
    },

    // ── State Entries ────────────────────────────────────────

    async getStateEntry(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateEntryRecord | null> {
      const rows = await db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
            eq(schema.stateEntries.fieldName, fieldName),
          ),
        );
      return rows.length > 0 ? toStateEntryRecord(rows[0]) : null;
    },

    async upsertStateEntry(record: StateEntryRecord): Promise<void> {
      await db
        .insert(schema.stateEntries)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          tableName: record.tableName,
          fieldName: record.fieldName,
          value: record.value ?? null,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.stateEntries.sessionId,
            schema.stateEntries.tableName,
            schema.stateEntries.fieldName,
          ],
          set: {
            value: record.value ?? null,
            updatedAt: record.updatedAt,
          },
        });
    },

    async listStateEntries(
      sessionId: string,
      tableName: string,
    ): Promise<StateEntryRecord[]> {
      const rows = await db
        .select()
        .from(schema.stateEntries)
        .where(
          and(
            eq(schema.stateEntries.sessionId, sessionId),
            eq(schema.stateEntries.tableName, tableName),
          ),
        );
      return rows.map(toStateEntryRecord);
    },

    // ── State Changes ────────────────────────────────────────

    async addStateChange(record: StateChangeRecord): Promise<void> {
      await db.insert(schema.stateChanges).values({
        id: record.id,
        sessionId: record.sessionId,
        tableName: record.tableName,
        fieldName: record.fieldName,
        value: record.value ?? null,
        changedBy: record.changedBy,
        turnId: record.turnId,
        reason: record.reason ?? null,
        createdAt: record.createdAt,
      });
    },

    async listStateChanges(
      sessionId: string,
      tableName: string,
      fieldName: string,
    ): Promise<StateChangeRecord[]> {
      const rows = await db
        .select()
        .from(schema.stateChanges)
        .where(
          and(
            eq(schema.stateChanges.sessionId, sessionId),
            eq(schema.stateChanges.tableName, tableName),
            eq(schema.stateChanges.fieldName, fieldName),
          ),
        )
        .orderBy(asc(schema.stateChanges.createdAt));
      return rows.map(toStateChangeRecord);
    },

    // ── Events ───────────────────────────────────────────────

    async saveEvent(record: EventRecord): Promise<void> {
      await db.insert(schema.events).values({
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

      let query = db
        .select()
        .from(schema.events)
        .where(and(...conditions))
        .orderBy(asc(schema.events.createdAt));

      const rows =
        options?.limit != null ? await query.limit(options.limit) : await query;
      return rows.map(toEventRecord);
    },

    // ── Approvals ────────────────────────────────────────────

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await db.insert(schema.approvals).values({
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
      const rows = await db
        .select()
        .from(schema.approvals)
        .where(eq(schema.approvals.sessionId, sessionId));
      return rows.map(toApprovalRecord);
    },

    // ── Messages ─────────────────────────────────────────────

    async addMessage(record: MessageRecord): Promise<void> {
      await db.insert(schema.messages).values({
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
      let query = db
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

    // ── Characters ───────────────────────────────────────────

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await db
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
      const rows = await db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.sessionId, sessionId));
      return rows.map(toCharacterRecord);
    },

    // ── Plugin Data ──────────────────────────────────────────

    async setPluginData(record: PluginDataRecord): Promise<void> {
      await db
        .insert(schema.pluginData)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          pluginId: record.pluginId,
          namespace: record.namespace,
          key: record.key,
          value: record.value ?? null,
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
            value: record.value ?? null,
            updatedAt: record.updatedAt,
          },
        });
    },

    async setPluginDataBatch(
      records: readonly PluginDataRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await db.transaction(async (tx) => {
        for (const record of records) {
          await tx
            .insert(schema.pluginData)
            .values({
              id: record.id,
              sessionId: record.sessionId,
              pluginId: record.pluginId,
              namespace: record.namespace,
              key: record.key,
              value: record.value ?? null,
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
                value: record.value ?? null,
                updatedAt: record.updatedAt,
              },
            });
        }
      });
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const rows = await db
        .select()
        .from(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        );
      return rows.length > 0 ? toPluginDataRecord(rows[0]) : null;
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
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toPluginDataRecord);
    },

    async listPluginDataSessionScope(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<readonly PluginDataRecord[]> {
      // Full session scope — used by the snapshot payload builder to avoid
      // missing plugins that never produced a runtime result (audit
      // 2026-04-20 finding 7.2).
      let query = db
        .select()
        .from(schema.pluginData)
        .where(eq(schema.pluginData.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toPluginDataRecord);
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      await db
        .delete(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        );
    },

    // ── Plugin Configs ───────────────────────────────────────

    async savePluginConfig(record: PluginConfigRecord): Promise<void> {
      await db
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
      const rows = await db
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

    // ── Worlds ───────────────────────────────────────────────

    async listWorlds(): Promise<WorldRecord[]> {
      const rows = await db.select().from(schema.worlds);
      return rows.map(toWorldRecord);
    },

    async getWorld(id: string): Promise<WorldRecord | null> {
      const rows = await db
        .select()
        .from(schema.worlds)
        .where(eq(schema.worlds.id, id));
      return rows.length > 0 ? toWorldRecord(rows[0]) : null;
    },

    async upsertWorld(record: WorldRecord): Promise<void> {
      await db
        .insert(schema.worlds)
        .values({
          id: record.id,
          name: record.name,
          description: record.description,
          lore: record.lore ?? null,
          tags: record.tags ?? null,
          locale: record.locale ?? null,
          metadata: record.metadata ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.worlds.id,
          set: {
            name: record.name,
            description: record.description,
            lore: record.lore ?? null,
            tags: record.tags ?? null,
            locale: record.locale ?? null,
            metadata: record.metadata ?? null,
            updatedAt: record.updatedAt ?? null,
          },
        });
    },

    async deleteWorld(id: string): Promise<void> {
      await db.delete(schema.worlds).where(eq(schema.worlds.id, id));
    },

    // ── Trace Events ─────────────────────────────────────────

    async addTraceEvent(record: TraceEventRecord): Promise<void> {
      await db.insert(schema.traceEvents).values({
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
      let query = db
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

    // ── Runtime Outputs (PR-1) ──────────────────────────────

    async saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void> {
      await db.insert(schema.runtimeOutputs).values({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        runtimeResultId: record.runtimeResultId ?? null,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        timestamp: record.timestamp,
        results: record.results ?? [],
        metaData: record.metaData ?? {},
        createdAt: record.createdAt,
      });
    },

    async getRuntimeOutput(
      sessionId: string,
      id: string,
    ): Promise<RuntimeOutputRecord | null> {
      const rows = await db
        .select()
        .from(schema.runtimeOutputs)
        .where(
          and(
            eq(schema.runtimeOutputs.sessionId, sessionId),
            eq(schema.runtimeOutputs.id, id),
          ),
        )
        .limit(1);
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
      const rows = await query;
      return rows.map(toRuntimeOutputRecord);
    },

    // ── Interaction Records (PR-1) ──────────────────────────

    async saveInteractionRecord(record: InteractionRecordRow): Promise<void> {
      await db.insert(schema.interactionRecords).values({
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId ?? null,
        timestamp: record.timestamp,
        source: record.source,
        channel: record.channel,
        type: record.type,
        targetPluginId: record.targetPluginId ?? null,
        targetRuntimeId: record.targetRuntimeId ?? null,
        payload: record.payload ?? null,
        metaData: record.metaData ?? null,
        createdAt: record.createdAt,
      });
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
      const rows = await query;
      return rows.map(toInteractionRecordRow);
    },

    // ── Turn Messages ───────────────────────────────────────

    async appendTurnMessage(record: TurnMessageRecord): Promise<void> {
      await db.insert(schema.turnMessages).values({
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
      let query = db
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

    // ── Player Inputs ───────────────────────────────────────

    async savePlayerInput(record: PlayerInputRecord): Promise<void> {
      await db.insert(schema.playerInputs).values({
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
      const rows = await db
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
      const rows = await db
        .select()
        .from(schema.playerInputs)
        .where(eq(schema.playerInputs.sessionId, sessionId));
      return rows.map(toPlayerInputRecord);
    },

    // ── Working Memory (S3-T3) ───────────────────────────────

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      await db
        .insert(schema.workingMemory)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          key: record.key,
          scope: record.scope,
          value: record.value ?? null,
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
            value: record.value ?? null,
            schemaRef: record.schemaRef ?? null,
            updatedAt: record.updatedAt,
          },
        });
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const rows = await db
        .select()
        .from(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        );
      return rows.length > 0 ? toWorkingMemoryRecord(rows[0]) : null;
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const rows = await db
        .select()
        .from(schema.workingMemory)
        .where(eq(schema.workingMemory.sessionId, sessionId))
        .orderBy(
          asc(schema.workingMemory.scope),
          asc(schema.workingMemory.key),
        );
      return rows.map(toWorkingMemoryRecord);
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      await db
        .delete(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        );
    },

    // ── Lorebook Entries (S3-T2) ──────────────────────────────

    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      for (const r of records) {
        await db
          .insert(schema.lorebookEntries)
          .values({
            id: r.id,
            sessionId: r.sessionId,
            pluginId: r.pluginId,
            keys: r.keys as unknown as string[],
            content: r.content,
            strategy: r.strategy,
            position: r.position,
            insertionOrder: r.insertionOrder,
            enabled: r.enabled ? 1 : 0,
            extra: (r.extra ?? null) as unknown,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })
          .onConflictDoUpdate({
            target: schema.lorebookEntries.id,
            set: {
              sessionId: r.sessionId,
              pluginId: r.pluginId,
              keys: r.keys as unknown as string[],
              content: r.content,
              strategy: r.strategy,
              position: r.position,
              insertionOrder: r.insertionOrder,
              enabled: r.enabled ? 1 : 0,
              extra: (r.extra ?? null) as unknown,
              updatedAt: r.updatedAt,
            },
          });
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const rows = await db
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.sessionId, sessionId))
        .orderBy(
          asc(schema.lorebookEntries.insertionOrder),
          asc(schema.lorebookEntries.id),
        );
      return rows.map(toLorebookEntryRecord);
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      await db
        .delete(schema.lorebookEntries)
        .where(
          and(
            eq(schema.lorebookEntries.sessionId, sessionId),
            eq(schema.lorebookEntries.id, id),
          ),
        );
    },

    // ── Session Summaries (S2-T2 Compactor) ─────────────────

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      await db.insert(schema.sessionSummaries).values({
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
      const rows = await db
        .select()
        .from(schema.sessionSummaries)
        .where(eq(schema.sessionSummaries.sessionId, sessionId));
      return rows.map(toSessionSummaryRecord);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      await db
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
        await db
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

    // ── Suspensions (S4-T4) ─────────────────────────────────

    async saveSuspension(record: SuspensionRecord): Promise<void> {
      await db
        .insert(schema.suspensions)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          runtimeId: record.runtimeId,
          pluginId: record.pluginId,
          reason: record.reason,
          resumeSchema: record.resumeSchema as Record<string, unknown>,
          pendingContinuation: record.pendingContinuation as Record<
            string,
            unknown
          >,
          createdAt: record.createdAt,
          resolvedAt: record.resolvedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.suspensions.id,
          set: {
            reason: record.reason,
            resumeSchema: record.resumeSchema as Record<string, unknown>,
            pendingContinuation: record.pendingContinuation as Record<
              string,
              unknown
            >,
            resolvedAt: record.resolvedAt ?? null,
          },
        });
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      const rows = await db
        .select()
        .from(schema.suspensions)
        .where(eq(schema.suspensions.id, id));
      return rows[0] ? toSuspensionRecord(rows[0]) : null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      await db
        .update(schema.suspensions)
        .set({ resolvedAt: new Date().toISOString() })
        .where(eq(schema.suspensions.id, id));
    },

    async claimSuspension(id: string): Promise<boolean> {
      // Atomic compare-and-swap: Postgres evaluates the WHERE predicate and
      // writes the new value in a single statement. Concurrent claims race
      // on row-level locks — exactly one sees `resolvedAt IS NULL` and
      // receives a non-empty RETURNING set. The sentinel `claimed:<iso>` is
      // later overwritten by `markSuspensionResolved` with the final
      // timestamp.
      const rows = await db
        .update(schema.suspensions)
        .set({ resolvedAt: `claimed:${new Date().toISOString()}` })
        .where(
          and(
            eq(schema.suspensions.id, id),
            isNull(schema.suspensions.resolvedAt),
          ),
        )
        .returning({ id: schema.suspensions.id });
      return rows.length === 1;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const rows = await db
        .select()
        .from(schema.suspensions)
        .where(eq(schema.suspensions.sessionId, sessionId))
        .orderBy(asc(schema.suspensions.createdAt));
      return rows.map(toSuspensionRecord);
    },

    async deleteSuspension(id: string): Promise<void> {
      await db.delete(schema.suspensions).where(eq(schema.suspensions.id, id));
    },

    // ── Snapshots (S4-T2) ─────────────────────────────────────

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      await db
        .insert(schema.stateSnapshots)
        .values({
          id: record.id,
          sessionId: record.sessionId,
          turnId: record.turnId,
          kind: record.kind,
          parentId: record.parentId ?? null,
          payload: record.payload as unknown as Record<string, unknown>,
          createdAt: record.createdAt,
        })
        .onConflictDoUpdate({
          target: schema.stateSnapshots.id,
          set: {
            turnId: record.turnId,
            kind: record.kind,
            parentId: record.parentId ?? null,
            payload: record.payload as unknown as Record<string, unknown>,
          },
        });
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      const rows = await db
        .select()
        .from(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.id, id));
      return rows[0] ? toSnapshotRecord(rows[0]) : null;
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const rows = await db
        .select()
        .from(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.sessionId, sessionId))
        .orderBy(asc(schema.stateSnapshots.createdAt));
      return rows.map(toSnapshotRecord);
    },

    async deleteSnapshot(id: string): Promise<void> {
      await db
        .delete(schema.stateSnapshots)
        .where(eq(schema.stateSnapshots.id, id));
    },

    // ── Transactions (S4-T1) ──────────────────────────────────
    // See pg-store-tx.ts for the callback-to-imperative adapter.

    beginTx: txAdapter.beginTx,
    commitTx: txAdapter.commitTx,
    rollbackTx: txAdapter.rollbackTx,

    // ── Lifecycle ────────────────────────────────────────────

    async close(): Promise<void> {
      await txAdapter.closeActiveTx();
      await client.end();
    },
  };

  // Mixin vector capability onto the base store.
  const vectorCap = createPgVectorCapability(client);
  return Object.assign(baseStore, vectorCap);
}
