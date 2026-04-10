/**
 * SQLite store helpers: JSON serialization, table DDL, and row→record mappers.
 *
 * Extracted from sqlite-store.ts to keep the factory module focused on
 * DataStore method implementations.
 */

import type Database from 'better-sqlite3';
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
} from '../types.js';

// ── JSON helpers ────────────────────────────────────────────────

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson(raw: string | null | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function fromJsonRequired(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Table creation ──────────────────────────────────────────────

export function createTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      lore TEXT,
      tags TEXT,
      locale TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT,
      phase TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      active_plugins TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_results TEXT NOT NULL,
      conflicts TEXT,
      audit_result TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_results_session_id_idx ON turn_results(session_id);
    CREATE INDEX IF NOT EXISTS turn_results_turn_id_idx ON turn_results(turn_id);

    CREATE TABLE IF NOT EXISTS runtime_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      tool_calls TEXT,
      duration_ms INTEGER NOT NULL,
      token_usage TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_results_session_id_idx ON runtime_results(session_id);
    CREATE INDEX IF NOT EXISTS runtime_results_turn_id_idx ON runtime_results(turn_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      input TEXT,
      output TEXT,
      duration_ms INTEGER NOT NULL,
      approval_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_session_id_idx ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS tool_calls_turn_id_idx ON tool_calls(turn_id);

    CREATE TABLE IF NOT EXISTS state_schemas (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      schema TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_schemas_session_id_idx ON state_schemas(session_id);

    CREATE TABLE IF NOT EXISTS state_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      field_name TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_entries_session_id_idx ON state_entries(session_id);
    CREATE INDEX IF NOT EXISTS state_entries_composite_idx ON state_entries(session_id, table_name, field_name);

    CREATE TABLE IF NOT EXISTS state_changes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      field_name TEXT NOT NULL,
      value TEXT,
      changed_by TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_changes_session_id_idx ON state_changes(session_id);
    CREATE INDEX IF NOT EXISTS state_changes_composite_idx ON state_changes(session_id, table_name, field_name);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload TEXT,
      target_runtime TEXT,
      turn_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session_id_idx ON events(session_id);
    CREATE INDEX IF NOT EXISTS events_topic_idx ON events(session_id, topic);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      decision TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_session_id_idx ON approvals(session_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      fields TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS characters_session_id_idx ON characters(session_id);

    CREATE TABLE IF NOT EXISTS plugin_data (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, plugin_id, namespace, key)
    );
    CREATE INDEX IF NOT EXISTS plugin_data_session_id_idx ON plugin_data(session_id);

    CREATE TABLE IF NOT EXISTS plugin_configs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plugin_configs_session_id_idx ON plugin_configs(session_id);
    CREATE INDEX IF NOT EXISTS plugin_configs_composite_idx ON plugin_configs(session_id, plugin_id);

    CREATE TABLE IF NOT EXISTS trace_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trace_events_session_id_idx ON trace_events(session_id);

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
      ui TEXT,
      pending_input TEXT,
      "order" INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_messages_session ON turn_messages(session_id);

    CREATE TABLE IF NOT EXISTS player_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      "values" TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_player_inputs_session ON player_inputs(session_id);
  `);
}

// ── Row → Record mappers ────────────────────────────────────────

export function toSessionRecord(row: typeof schema.sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    phase: row.phase,
    turnCount: row.turnCount,
    locale: row.locale,
    activePlugins: JSON.parse(row.activePlugins) as string[],
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
    tags: fromJson(row.tags) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata: fromJson(row.metadata) as Record<string, unknown> | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}

export function toTurnResultRecord(row: typeof schema.turnResults.$inferSelect): TurnResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResults: fromJsonRequired(row.runtimeResults),
    conflicts: fromJson(row.conflicts),
    auditResult: fromJson(row.auditResult),
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
    output: fromJson(row.output),
    toolCalls: fromJson(row.toolCalls),
    durationMs: row.durationMs,
    tokenUsage: fromJson(row.tokenUsage),
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
    input: fromJson(row.input),
    output: fromJson(row.output),
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
    schema: fromJsonRequired(row.schema),
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(row: typeof schema.stateEntries.$inferSelect): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: fromJson(row.value),
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(row: typeof schema.stateChanges.$inferSelect): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: fromJson(row.value),
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
    payload: fromJson(row.payload),
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
    metadata: fromJson(row.metadata),
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
    fields: fromJson(row.fields),
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
    value: fromJson(row.value),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginConfigRecord(row: typeof schema.pluginConfigs.$inferSelect): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: fromJsonRequired(row.config),
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
    payload: fromJson(row.payload),
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
    ui: fromJson(row.ui),
    pendingInput: fromJson(row.pendingInput),
    order: row.order,
    createdAt: row.createdAt,
  };
}

export function toPlayerInputRecord(row: typeof schema.playerInputs.$inferSelect): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: fromJsonRequired(row.values),
    createdAt: row.createdAt,
  };
}
