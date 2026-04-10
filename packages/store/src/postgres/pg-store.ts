/**
 * PostgreSQL-backed DataStore implementation using Drizzle ORM + postgres.js.
 *
 * All operations are truly async (unlike better-sqlite3).
 * JSON fields use native `jsonb` — no manual stringify/parse needed.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, asc } from 'drizzle-orm';
import * as schema from './schema.js';
import type {
  DataStore,
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

// ── Table creation DDL ─────────────────────────────────────────

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    lore TEXT,
    tags JSONB,
    locale TEXT,
    metadata JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    world_id TEXT,
    phase TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    locale TEXT NOT NULL DEFAULT 'zh-CN',
    active_plugins JSONB NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS turn_results (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    runtime_results JSONB NOT NULL,
    conflicts JSONB,
    audit_result JSONB,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_turn_results_session_id_idx ON turn_results(session_id);
  CREATE INDEX IF NOT EXISTS pg_turn_results_turn_id_idx ON turn_results(turn_id);

  CREATE TABLE IF NOT EXISTS runtime_results (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output JSONB,
    tool_calls JSONB,
    duration_ms INTEGER NOT NULL,
    token_usage JSONB,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_runtime_results_session_id_idx ON runtime_results(session_id);
  CREATE INDEX IF NOT EXISTS pg_runtime_results_turn_id_idx ON runtime_results(turn_id);

  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    input JSONB,
    output JSONB,
    duration_ms INTEGER NOT NULL,
    approval_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_tool_calls_session_id_idx ON tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS pg_tool_calls_turn_id_idx ON tool_calls(turn_id);

  CREATE TABLE IF NOT EXISTS state_schemas (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    schema JSONB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_state_schemas_session_id_idx ON state_schemas(session_id);

  CREATE TABLE IF NOT EXISTS state_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    field_name TEXT NOT NULL,
    value JSONB,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_state_entries_session_id_idx ON state_entries(session_id);
  CREATE INDEX IF NOT EXISTS pg_state_entries_composite_idx ON state_entries(session_id, table_name, field_name);

  CREATE TABLE IF NOT EXISTS state_changes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    field_name TEXT NOT NULL,
    value JSONB,
    changed_by TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_state_changes_session_id_idx ON state_changes(session_id);
  CREATE INDEX IF NOT EXISTS pg_state_changes_composite_idx ON state_changes(session_id, table_name, field_name);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    topic TEXT NOT NULL,
    payload JSONB,
    target_runtime TEXT,
    turn_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_events_session_id_idx ON events(session_id);
  CREATE INDEX IF NOT EXISTS pg_events_topic_idx ON events(session_id, topic);

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    decision TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_approvals_session_id_idx ON approvals(session_id);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_messages_session_id_idx ON messages(session_id);

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    fields JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_characters_session_id_idx ON characters(session_id);

  CREATE TABLE IF NOT EXISTS plugin_data (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, plugin_id, namespace, key)
  );
  CREATE INDEX IF NOT EXISTS pg_plugin_data_session_id_idx ON plugin_data(session_id);

  CREATE TABLE IF NOT EXISTS plugin_configs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    config JSONB NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_plugin_configs_session_id_idx ON plugin_configs(session_id);
  CREATE INDEX IF NOT EXISTS pg_plugin_configs_composite_idx ON plugin_configs(session_id, plugin_id);

  CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    payload JSONB,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_trace_events_session_id_idx ON trace_events(session_id);

  CREATE TABLE IF NOT EXISTS turn_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_plugin_id TEXT,
    source_runtime_id TEXT,
    role TEXT NOT NULL,
    name TEXT,
    content TEXT NOT NULL,
    ui JSONB,
    pending_input JSONB,
    "order" INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_turn_messages_session_id_idx ON turn_messages(session_id);

  CREATE TABLE IF NOT EXISTS player_inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    "values" JSONB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_player_inputs_session_id_idx ON player_inputs(session_id);
`;

// ── Table names for cleanup ─────────────────────────────────────

const ALL_TABLE_NAMES = [
  'worlds', 'sessions', 'turn_results', 'runtime_results', 'tool_calls',
  'state_schemas', 'state_entries', 'state_changes', 'events', 'approvals',
  'messages', 'characters', 'plugin_data', 'plugin_configs', 'trace_events',
  'turn_messages', 'player_inputs',
] as const;

const DROP_ALL_SQL = ALL_TABLE_NAMES.map(
  (t) => `DROP TABLE IF EXISTS ${t} CASCADE;`,
).join('\n');

// ── Row → Record mappers ────────────────────────────────────────

function toSessionRecord(row: typeof schema.sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    phase: row.phase,
    turnCount: row.turnCount,
    locale: row.locale,
    activePlugins: (row.activePlugins ?? []) as string[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorldRecord(row: typeof schema.worlds.$inferSelect): WorldRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: (row.tags ?? undefined) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}

function toTurnResultRecord(row: typeof schema.turnResults.$inferSelect): TurnResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResults: row.runtimeResults ?? null,
    conflicts: row.conflicts ?? undefined,
    auditResult: row.auditResult ?? undefined,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

function toRuntimeResultRecord(row: typeof schema.runtimeResults.$inferSelect): RuntimeResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    status: row.status,
    output: row.output ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    durationMs: row.durationMs,
    tokenUsage: row.tokenUsage ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
  };
}

function toToolCallRecord(row: typeof schema.toolCalls.$inferSelect): ToolCallRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    durationMs: row.durationMs,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt,
  };
}

function toStateSchemaRecord(row: typeof schema.stateSchemas.$inferSelect): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: row.schema ?? null,
    createdAt: row.createdAt,
  };
}

function toStateEntryRecord(row: typeof schema.stateEntries.$inferSelect): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: row.value ?? undefined,
    updatedAt: row.updatedAt,
  };
}

function toStateChangeRecord(row: typeof schema.stateChanges.$inferSelect): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: row.value ?? undefined,
    changedBy: row.changedBy,
    turnId: row.turnId,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
  };
}

function toEventRecord(row: typeof schema.events.$inferSelect): EventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    topic: row.topic,
    payload: row.payload ?? undefined,
    targetRuntime: row.targetRuntime ?? undefined,
    turnId: row.turnId ?? undefined,
    createdAt: row.createdAt,
  };
}

function toApprovalRecord(row: typeof schema.approvals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    decision: row.decision,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

function toMessageRecord(row: typeof schema.messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

function toCharacterRecord(row: typeof schema.characters.$inferSelect): CharacterRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    type: row.type,
    description: row.description ?? undefined,
    fields: row.fields ?? undefined,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPluginDataRecord(row: typeof schema.pluginData.$inferSelect): PluginDataRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    value: row.value ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPluginConfigRecord(row: typeof schema.pluginConfigs.$inferSelect): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: row.config ?? null,
    updatedAt: row.updatedAt,
  };
}

function toTraceEventRecord(row: typeof schema.traceEvents.$inferSelect): TraceEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    traceId: row.traceId,
    turnId: row.turnId,
    payload: row.payload ?? undefined,
    createdAt: row.createdAt,
  };
}

function toTurnMessageRecord(row: typeof schema.turnMessages.$inferSelect): TurnMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    sourceType: row.sourceType,
    sourcePluginId: row.sourcePluginId ?? undefined,
    sourceRuntimeId: row.sourceRuntimeId ?? undefined,
    role: row.role,
    name: row.name ?? undefined,
    content: row.content,
    ui: row.ui ?? undefined,
    pendingInput: row.pendingInput ?? undefined,
    order: row.order,
    createdAt: row.createdAt,
  };
}

function toPlayerInputRecord(row: typeof schema.playerInputs.$inferSelect): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: row.values ?? null,
    createdAt: row.createdAt,
  };
}

// ── Factory ─────────────────────────────────────────────────────

export interface PgStoreOptions {
  /** Drop and recreate all tables (for test isolation). Default: false. */
  readonly freshSchema?: boolean;
}

export async function createPgStore(
  databaseUrl: string,
  options?: PgStoreOptions,
): Promise<DataStore> {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  if (options?.freshSchema) {
    await client.unsafe(DROP_ALL_SQL);
  }

  // Create tables (idempotent)
  await client.unsafe(CREATE_TABLES_SQL);

  return {
    // ── Session ──────────────────────────────────────────────

    async createSession(session: SessionRecord): Promise<void> {
      await db.insert(schema.sessions).values({
        id: session.id,
        worldId: session.worldId ?? null,
        phase: session.phase,
        turnCount: session.turnCount,
        locale: session.locale,
        activePlugins: session.activePlugins as string[],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
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
      patch: Partial<Pick<SessionRecord, 'phase' | 'turnCount' | 'activePlugins' | 'updatedAt'>>,
    ): Promise<void> {
      const values: Record<string, unknown> = {};
      if (patch.phase !== undefined) values.phase = patch.phase;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.activePlugins !== undefined) values.activePlugins = patch.activePlugins as string[];
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;

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
      await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
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

    async getTurnResult(sessionId: string, turnId: string): Promise<TurnResultRecord | null> {
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

    async listTurnResults(sessionId: string, limit?: number): Promise<TurnResultRecord[]> {
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

    async listRuntimeResults(sessionId: string, turnId: string): Promise<RuntimeResultRecord[]> {
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

    async listToolCalls(sessionId: string, turnId?: string): Promise<ToolCallRecordRow[]> {
      const condition = turnId != null
        ? and(
            eq(schema.toolCalls.sessionId, sessionId),
            eq(schema.toolCalls.turnId, turnId),
          )
        : eq(schema.toolCalls.sessionId, sessionId);

      const rows = await db
        .select()
        .from(schema.toolCalls)
        .where(condition);
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

    async deleteStateSchema(sessionId: string, tableName: string): Promise<void> {
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
          target: schema.stateEntries.id,
          set: {
            value: record.value ?? null,
            updatedAt: record.updatedAt,
          },
        });
    },

    async listStateEntries(sessionId: string, tableName: string): Promise<StateEntryRecord[]> {
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

      const rows = options?.limit != null ? await query.limit(options.limit) : await query;
      return rows.map(toEventRecord);
    },

    // ── Approvals ────────────────────────────────────────────

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await db.insert(schema.approvals).values({
        id: record.id,
        sessionId: record.sessionId,
        toolName: record.toolName,
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

    async listMessages(sessionId: string): Promise<MessageRecord[]> {
      const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.sessionId, sessionId))
        .orderBy(asc(schema.messages.createdAt));
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

    async setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void> {
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
    ): Promise<PluginDataRecord[]> {
      const conditions = [
        eq(schema.pluginData.sessionId, sessionId),
        eq(schema.pluginData.pluginId, pluginId),
      ];
      if (namespace != null) {
        conditions.push(eq(schema.pluginData.namespace, namespace));
      }

      const rows = await db
        .select()
        .from(schema.pluginData)
        .where(and(...conditions));
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

    async listTraceEvents(sessionId: string): Promise<TraceEventRecord[]> {
      const rows = await db
        .select()
        .from(schema.traceEvents)
        .where(eq(schema.traceEvents.sessionId, sessionId));
      return rows.map(toTraceEventRecord);
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
      });
    },

    async listTurnMessages(sessionId: string): Promise<TurnMessageRecord[]> {
      const rows = await db
        .select()
        .from(schema.turnMessages)
        .where(eq(schema.turnMessages.sessionId, sessionId))
        .orderBy(asc(schema.turnMessages.createdAt));
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

    async getPlayerInput(sessionId: string, formId: string): Promise<PlayerInputRecord | null> {
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

    // ── Lifecycle ────────────────────────────────────────────

    async close(): Promise<void> {
      await client.end();
    },
  };
}
