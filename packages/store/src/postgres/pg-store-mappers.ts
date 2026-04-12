/**
 * PostgreSQL DDL constants and row→record mapper functions.
 *
 * Extracted from pg-store.ts to keep the store implementation focused
 * on DataStore method logic.
 */

import * as schema from './schema.js';
import type {
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
  WorkingMemoryRecord,
  SessionSummaryRecord,
} from '../types.js';

// ── Table creation DDL ─────────────────────────────────────────

export const CREATE_TABLES_SQL = `
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
    created_at TEXT NOT NULL,
    compacted_at_turn_id TEXT
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

  CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    scope TEXT NOT NULL,
    value JSONB NOT NULL,
    schema_ref TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, scope, key)
  );
  CREATE INDEX IF NOT EXISTS pg_working_memory_session_id_idx ON working_memory(session_id);

  CREATE TABLE IF NOT EXISTS session_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_range_start TEXT NOT NULL,
    turn_range_end TEXT NOT NULL,
    content TEXT NOT NULL,
    focus_sections JSONB NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_session_summaries_session_id_idx ON session_summaries(session_id);
`;

// ── Table names for cleanup ─────────────────────────────────────

export const ALL_TABLE_NAMES = [
  'worlds', 'sessions', 'turn_results', 'runtime_results', 'tool_calls',
  'state_schemas', 'state_entries', 'state_changes', 'events', 'approvals',
  'messages', 'characters', 'plugin_data', 'plugin_configs', 'trace_events',
  'turn_messages', 'player_inputs', 'working_memory', 'session_summaries',
] as const;

export const DROP_ALL_SQL = ALL_TABLE_NAMES.map(
  (t) => `DROP TABLE IF EXISTS ${t} CASCADE;`,
).join('\n');

// ── Row → Record mappers ────────────────────────────────────────

export function toSessionRecord(row: typeof schema.sessions.$inferSelect): SessionRecord {
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

export function toWorldRecord(row: typeof schema.worlds.$inferSelect): WorldRecord {
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

export function toTurnResultRecord(row: typeof schema.turnResults.$inferSelect): TurnResultRecord {
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

export function toRuntimeResultRecord(row: typeof schema.runtimeResults.$inferSelect): RuntimeResultRecord {
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

export function toToolCallRecord(row: typeof schema.toolCalls.$inferSelect): ToolCallRecordRow {
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

export function toStateSchemaRecord(row: typeof schema.stateSchemas.$inferSelect): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: row.schema ?? null,
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(row: typeof schema.stateEntries.$inferSelect): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: row.value ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(row: typeof schema.stateChanges.$inferSelect): StateChangeRecord {
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

export function toEventRecord(row: typeof schema.events.$inferSelect): EventRecord {
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

export function toApprovalRecord(row: typeof schema.approvals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    decision: row.decision,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

export function toMessageRecord(row: typeof schema.messages.$inferSelect): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toCharacterRecord(row: typeof schema.characters.$inferSelect): CharacterRecord {
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

export function toPluginDataRecord(row: typeof schema.pluginData.$inferSelect): PluginDataRecord {
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

export function toPluginConfigRecord(row: typeof schema.pluginConfigs.$inferSelect): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: row.config ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toTraceEventRecord(row: typeof schema.traceEvents.$inferSelect): TraceEventRecord {
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

export function toTurnMessageRecord(row: typeof schema.turnMessages.$inferSelect): TurnMessageRecord {
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
    compactedAtTurnId: row.compactedAtTurnId ?? undefined,
  };
}

export function toPlayerInputRecord(row: typeof schema.playerInputs.$inferSelect): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: row.values ?? null,
    createdAt: row.createdAt,
  };
}

export function toWorkingMemoryRecord(row: typeof schema.workingMemory.$inferSelect): WorkingMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    key: row.key,
    scope: row.scope as WorkingMemoryRecord['scope'],
    value: row.value ?? null,
    schemaRef: row.schemaRef ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toSessionSummaryRecord(row: typeof schema.sessionSummaries.$inferSelect): SessionSummaryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnRangeStart: row.turnRangeStart,
    turnRangeEnd: row.turnRangeEnd,
    content: row.content,
    focusSections: (row.focusSections as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
}
