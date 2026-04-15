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
  RuntimeOutputRecord,
  InteractionRecordRow,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotKind,
  SnapshotPayload,
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

    -- Runtime Outputs (PR-1 translation layer)
    CREATE TABLE IF NOT EXISTS runtime_outputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_result_id TEXT,
      plugin_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      results TEXT NOT NULL,
      meta_data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_outputs_session_time_idx ON runtime_outputs(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS runtime_outputs_runtime_idx ON runtime_outputs(session_id, runtime_id);
    CREATE INDEX IF NOT EXISTS runtime_outputs_plugin_idx ON runtime_outputs(session_id, plugin_id);

    -- Interaction Records (PR-1 translation layer)
    CREATE TABLE IF NOT EXISTS interaction_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      target_plugin_id TEXT,
      target_runtime_id TEXT,
      payload TEXT NOT NULL,
      meta_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS interaction_records_session_time_idx ON interaction_records(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS interaction_records_type_idx ON interaction_records(session_id, type);

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
      created_at TEXT NOT NULL,
      compacted_at_turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turn_messages_session ON turn_messages(session_id);

    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_range_start TEXT NOT NULL,
      turn_range_end TEXT NOT NULL,
      content TEXT NOT NULL,
      focus_sections TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);

    CREATE TABLE IF NOT EXISTS player_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      "values" TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_player_inputs_session ON player_inputs(session_id);

    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      value TEXT NOT NULL,
      schema_ref TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_session ON working_memory(session_id);

    CREATE TABLE IF NOT EXISTS lorebook_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      keys TEXT NOT NULL,
      content TEXT NOT NULL,
      strategy TEXT NOT NULL,
      position TEXT NOT NULL,
      insertion_order INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      extra TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lorebook_entries_session ON lorebook_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_lorebook_entries_plugin ON lorebook_entries(session_id, plugin_id);

    CREATE TABLE IF NOT EXISTS state_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_state_snapshots_session ON state_snapshots(session_id);

    CREATE TABLE IF NOT EXISTS suspensions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      resume_schema TEXT NOT NULL,
      pending_continuation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suspensions_session ON suspensions(session_id);

    CREATE TABLE IF NOT EXISTS vector_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      -- Auto-filled by the trigger below from the row id. Application
      -- code MUST NOT specify this column on INSERT — the schema-side
      -- trigger derives it as 'vec_mem_m{id}' so the registry stays
      -- consistent without a placeholder + UPDATE roundtrip.
      table_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      UNIQUE (model_id, dim)
    );

    -- Atomic table_name backfill: SQLite AFTER INSERT triggers see the
    -- generated rowid via NEW.id. The UPDATE runs in the same implicit
    -- transaction as the INSERT, so readers always see a populated row.
    CREATE TRIGGER IF NOT EXISTS vector_models_fill_table_name
      AFTER INSERT ON vector_models
      FOR EACH ROW
      WHEN NEW.table_name = '' OR NEW.table_name IS NULL
    BEGIN
      UPDATE vector_models
         SET table_name = 'vec_mem_m' || NEW.id
       WHERE id = NEW.id;
    END;
  `);

  // Migrations: add columns to sessions if they don't already exist
  const sessionCols = sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const colNames = new Set(sessionCols.map((c) => c.name));
  if (!colNames.has('embedding_model_id')) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN embedding_model_id INTEGER");
  }
  if (!colNames.has('embedding_locked_at')) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN embedding_locked_at TEXT");
  }
  if (!colNames.has('playing_turn_offset')) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN playing_turn_offset INTEGER");
  }
  if (!colNames.has('runtime_model_overrides')) {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN runtime_model_overrides TEXT DEFAULT '{}'");
  }
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
    ...(row.embeddingModelId != null ? { embeddingModelId: row.embeddingModelId } : {}),
    ...(row.embeddingLockedAt != null ? { embeddingLockedAt: row.embeddingLockedAt } : {}),
    ...(row.playingTurnOffset != null ? { playingTurnOffset: row.playingTurnOffset } : {}),
    ...(() => {
      const rmo = row.runtimeModelOverrides;
      if (!rmo || rmo === '{}') return {};
      try {
        const parsed = JSON.parse(rmo) as Record<string, string>;
        return Object.keys(parsed).length > 0 ? { runtimeModelOverrides: parsed } : {};
      } catch {
        return {};
      }
    })(),
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

export function toRuntimeOutputRecord(
  row: typeof schema.runtimeOutputs.$inferSelect,
): RuntimeOutputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResultId: row.runtimeResultId ?? undefined,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    timestamp: row.timestamp,
    results: fromJsonRequired(row.results),
    metaData: fromJsonRequired(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toInteractionRecordRow(
  row: typeof schema.interactionRecords.$inferSelect,
): InteractionRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? undefined,
    timestamp: row.timestamp,
    source: row.source,
    channel: row.channel,
    type: row.type,
    targetPluginId: row.targetPluginId ?? undefined,
    targetRuntimeId: row.targetRuntimeId ?? undefined,
    payload: fromJsonRequired(row.payload),
    metaData: fromJson(row.metaData),
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
    compactedAtTurnId: row.compactedAtTurnId ?? undefined,
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

export function toWorkingMemoryRecord(row: typeof schema.workingMemory.$inferSelect): WorkingMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    key: row.key,
    scope: row.scope as WorkingMemoryRecord['scope'],
    value: fromJsonRequired(row.value),
    schemaRef: row.schemaRef ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toLorebookEntryRecord(
  row: typeof schema.lorebookEntries.$inferSelect,
): LorebookEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    keys: ((fromJsonRequired(row.keys) as string[] | null) ?? []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord['strategy'],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: row.enabled !== 0,
    extra: row.extra == null ? undefined : fromJsonRequired(row.extra),
    createdAt: row.createdAt,
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
    focusSections: (fromJsonRequired(row.focusSections) as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
}

// ── Suspension row type (not in drizzle schema, raw sqlite) ─────

interface SuspensionRow {
  id: string;
  session_id: string;
  turn_id: string;
  runtime_id: string;
  plugin_id: string;
  reason: string;
  resume_schema: string;
  pending_continuation: string;
  created_at: string;
  resolved_at: string | null;
}

export function toSuspensionRecord(row: SuspensionRow): SuspensionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    runtimeId: row.runtime_id,
    pluginId: row.plugin_id,
    reason: row.reason,
    resumeSchema: fromJsonRequired(row.resume_schema),
    pendingContinuation: fromJsonRequired(row.pending_continuation) as SuspensionRecord['pendingContinuation'],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export type { SuspensionRow };

// ── Snapshot row type (not in drizzle schema, raw sqlite) ──────

interface SnapshotRow {
  id: string;
  session_id: string;
  turn_id: string;
  kind: string;
  parent_id: string | null;
  payload: string;
  created_at: string;
}

export function toSnapshotRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    kind: row.kind as SnapshotKind,
    parentId: row.parent_id ?? undefined,
    payload: fromJsonRequired(row.payload) as SnapshotPayload,
    createdAt: row.created_at,
  };
}

export type { SnapshotRow };
