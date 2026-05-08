/**
 * PostgreSQL DDL constants and row→record mapper functions.
 *
 * Extracted from pg-store.ts to keep the store implementation focused
 * on DataStore method logic.
 */

import type { SessionStatus } from "@covel/shared";
import * as schema from "./schema.js";
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
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotKind,
  SnapshotPayload,
} from "../types.js";

// ── Table creation DDL ─────────────────────────────────────────

export const CREATE_MEDIA_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    body BYTEA,
    path TEXT,
    object_key TEXT,
    meta JSONB,
    owner_session_id TEXT,
    owner_plugin_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS pg_media_assets_sha256_idx ON media_assets(sha256);
  CREATE INDEX IF NOT EXISTS pg_media_assets_owner_idx ON media_assets(owner_session_id, owner_plugin_id);

  -- media_refs: cross-session/plugin asset references for fork & inherit.
  --
  -- The UNIQUE constraint is on (session_id, media_id) only — plugin_id is
  -- recorded as "first-source metadata" but does NOT participate in the
  -- key. Rationale: PostgreSQL (and SQLite) treat each NULL as distinct in
  -- a UNIQUE column, which made the previous (session_id, media_id,
  -- plugin_id) constraint silently allow unbounded duplicate rows when
  -- callers passed undefined / NULL pluginId. addRef() is idempotent per
  -- (session_id, media_id) and the first writer's plugin_id is preserved.
  --
  -- Fresh installs: the inline UNIQUE below is created and the table starts
  -- correct. Existing databases get a NEW unique index added by name; any
  -- pre-existing (session_id, media_id, plugin_id) index is left alone (it
  -- becomes a redundant looser constraint and never blocks). Sites with
  -- legacy duplicate rows (same session_id + media_id, different plugin_id)
  -- MUST run a one-off migration before adding the new index:
  --   DELETE FROM media_refs a USING media_refs b
  --     WHERE a.ctid > b.ctid AND a.session_id = b.session_id AND a.media_id = b.media_id;
  -- See docs/reference/media-store.md for details.
  CREATE TABLE IF NOT EXISTS media_refs (
    session_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    plugin_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, media_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS pg_media_refs_unique_session_media_idx
    ON media_refs(session_id, media_id);
  CREATE INDEX IF NOT EXISTS pg_media_refs_session_id_idx ON media_refs(session_id);
  CREATE INDEX IF NOT EXISTS pg_media_refs_media_id_idx ON media_refs(media_id);
`;

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
    status TEXT NOT NULL DEFAULT 'active',
    turn_count INTEGER NOT NULL DEFAULT 0,
    pre_game_completed JSONB NOT NULL DEFAULT '[]'::jsonb,
    locale TEXT NOT NULL DEFAULT 'zh-CN',
    active_plugins JSONB NOT NULL DEFAULT '[]',
    metadata JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    embedding_model_id INTEGER,
    embedding_locked_at TEXT,
    runtime_model_overrides JSONB DEFAULT '{}'::jsonb
  );
  -- T3 (turn-band refactor): replace phase/playing_turn_offset with status/pre_game_completed.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pre_game_completed JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE sessions DROP COLUMN IF EXISTS phase;
  ALTER TABLE sessions DROP COLUMN IF EXISTS playing_turn_offset;
  -- PR-6: per-runtime model slot overrides.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_model_overrides JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB;

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
  CREATE UNIQUE INDEX IF NOT EXISTS pg_state_entries_unique_idx ON state_entries(session_id, table_name, field_name);

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
    plugin_id TEXT NOT NULL DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS world_data_import_ledger (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    target TEXT NOT NULL,
    plugin_id TEXT,
    namespace TEXT,
    key TEXT,
    source_world_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    schema_ref TEXT,
    derived_from JSONB,
    imported_at TEXT NOT NULL,
    managed INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS pg_world_data_import_ledger_session_id_idx ON world_data_import_ledger(session_id);
  CREATE INDEX IF NOT EXISTS pg_world_data_import_ledger_source_idx ON world_data_import_ledger(session_id, source_world_id, source_id);

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

  -- Runtime Outputs (PR-1 translation layer)
  CREATE TABLE IF NOT EXISTS runtime_outputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    runtime_result_id TEXT,
    plugin_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    results JSONB NOT NULL,
    meta_data JSONB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_runtime_outputs_session_time_idx ON runtime_outputs(session_id, timestamp);
  CREATE INDEX IF NOT EXISTS pg_runtime_outputs_runtime_idx ON runtime_outputs(session_id, runtime_id);
  CREATE INDEX IF NOT EXISTS pg_runtime_outputs_plugin_idx ON runtime_outputs(session_id, plugin_id);

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
    payload JSONB NOT NULL,
    meta_data JSONB,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_interaction_records_session_time_idx ON interaction_records(session_id, timestamp);
  CREATE INDEX IF NOT EXISTS pg_interaction_records_type_idx ON interaction_records(session_id, type);

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

  CREATE TABLE IF NOT EXISTS lorebook_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    keys JSONB NOT NULL,
    content TEXT NOT NULL,
    strategy TEXT NOT NULL,
    position TEXT NOT NULL,
    insertion_order INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    extra JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_lorebook_entries_session_id_idx ON lorebook_entries(session_id);
  CREATE INDEX IF NOT EXISTS pg_lorebook_entries_plugin_id_idx ON lorebook_entries(session_id, plugin_id);

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

  CREATE TABLE IF NOT EXISTS state_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id TEXT,
    payload JSONB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pg_state_snapshots_session_id_idx ON state_snapshots(session_id);

  CREATE TABLE IF NOT EXISTS suspensions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    resume_schema JSONB NOT NULL,
    pending_continuation JSONB NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS pg_suspensions_session_id_idx ON suspensions(session_id);

  CREATE TABLE IF NOT EXISTS vector_models (
    id SERIAL PRIMARY KEY,
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    dim INTEGER NOT NULL,
    -- Auto-filled by the trigger below from the row id. Application
    -- code MUST NOT specify this column on INSERT — the trigger derives
    -- it as 'vec_mem_m{id}' atomically, eliminating placeholder hacks.
    table_name TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    UNIQUE (model_id, dim)
  );

  -- BEFORE INSERT trigger: PG evaluates SERIAL defaults before BEFORE
  -- INSERT triggers fire, so NEW.id is already populated. We mutate
  -- NEW.table_name in place — no separate UPDATE statement needed.
  CREATE OR REPLACE FUNCTION vector_models_fill_table_name() RETURNS TRIGGER AS $fn$
  BEGIN
    IF NEW.table_name IS NULL OR NEW.table_name = '' THEN
      NEW.table_name := 'vec_mem_m' || NEW.id;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS vector_models_fill_table_name_trigger ON vector_models;
  CREATE TRIGGER vector_models_fill_table_name_trigger
    BEFORE INSERT ON vector_models
    FOR EACH ROW
    EXECUTE FUNCTION vector_models_fill_table_name();

  ${CREATE_MEDIA_TABLES_SQL}
`;

// ── Table names for cleanup ─────────────────────────────────────

export const ALL_TABLE_NAMES = [
  "worlds",
  "sessions",
  "turn_results",
  "runtime_results",
  "tool_calls",
  "state_schemas",
  "state_entries",
  "state_changes",
  "events",
  "approvals",
  "messages",
  "characters",
  "plugin_data",
  "world_data_import_ledger",
  "plugin_configs",
  "trace_events",
  "turn_messages",
  "player_inputs",
  "working_memory",
  "lorebook_entries",
  "session_summaries",
  "suspensions",
  "state_snapshots",
  "runtime_outputs",
  "interaction_records",
  "media_refs",
  "media_assets",
] as const;

export const DROP_ALL_SQL = ALL_TABLE_NAMES.map(
  (t) => `DROP TABLE IF EXISTS ${t} CASCADE;`,
).join("\n");

// ── Row → Record mappers ────────────────────────────────────────

export function toSessionRecord(
  row: typeof schema.sessions.$inferSelect,
): SessionRecord {
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: (row.status ?? "active") as SessionStatus,
    turnCount: row.turnCount,
    preGameCompleted: ((row.preGameCompleted as readonly string[] | null) ??
      []) as readonly string[],
    locale: row.locale,
    activePlugins: (row.activePlugins ?? []) as string[],
    ...(() => {
      const metadata = (row.metadata ?? undefined) as
        | Record<string, unknown>
        | undefined;
      return {
        metadata,
        ...(typeof metadata?.presetId === "string"
          ? { presetId: metadata.presetId }
          : {}),
      };
    })(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.embeddingModelId != null
      ? { embeddingModelId: row.embeddingModelId }
      : {}),
    ...(row.embeddingLockedAt != null
      ? { embeddingLockedAt: row.embeddingLockedAt }
      : {}),
    ...(row.runtimeModelOverrides &&
    Object.keys(row.runtimeModelOverrides as object).length > 0
      ? {
          runtimeModelOverrides: row.runtimeModelOverrides as Record<
            string,
            string
          >,
        }
      : {}),
  };
}

export function toWorldRecord(
  row: typeof schema.worlds.$inferSelect,
): WorldRecord {
  const metadata = (row.metadata ?? undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: (row.tags ?? undefined) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata,
    dimensions: metadata?.dimensions as WorldRecord["dimensions"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}

export function toTurnResultRecord(
  row: typeof schema.turnResults.$inferSelect,
): TurnResultRecord {
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

export function toRuntimeResultRecord(
  row: typeof schema.runtimeResults.$inferSelect,
): RuntimeResultRecord {
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

export function toToolCallRecord(
  row: typeof schema.toolCalls.$inferSelect,
): ToolCallRecordRow {
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

export function toStateSchemaRecord(
  row: typeof schema.stateSchemas.$inferSelect,
): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: row.schema ?? null,
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(
  row: typeof schema.stateEntries.$inferSelect,
): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: row.value,
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(
  row: typeof schema.stateChanges.$inferSelect,
): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: row.value,
    changedBy: row.changedBy,
    turnId: row.turnId,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toEventRecord(
  row: typeof schema.events.$inferSelect,
): EventRecord {
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

export function toApprovalRecord(
  row: typeof schema.approvals.$inferSelect,
): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    decision: row.decision,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

export function toMessageRecord(
  row: typeof schema.messages.$inferSelect,
): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toCharacterRecord(
  row: typeof schema.characters.$inferSelect,
): CharacterRecord {
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

export function toPluginDataRecord(
  row: typeof schema.pluginData.$inferSelect,
): PluginDataRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginConfigRecord(
  row: typeof schema.pluginConfigs.$inferSelect,
): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: row.config ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toTraceEventRecord(
  row: typeof schema.traceEvents.$inferSelect,
): TraceEventRecord {
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
    results: row.results,
    metaData: row.metaData,
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
    payload: row.payload,
    metaData: row.metaData ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toTurnMessageRecord(
  row: typeof schema.turnMessages.$inferSelect,
): TurnMessageRecord {
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

export function toPlayerInputRecord(
  row: typeof schema.playerInputs.$inferSelect,
): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: row.values ?? null,
    createdAt: row.createdAt,
  };
}

export function toWorkingMemoryRecord(
  row: typeof schema.workingMemory.$inferSelect,
): WorkingMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    key: row.key,
    scope: row.scope as WorkingMemoryRecord["scope"],
    value: row.value ?? null,
    schemaRef: row.schemaRef ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toWorldDataImportLedgerRecord(
  row: typeof schema.worldDataImportLedger.$inferSelect,
): WorldDataImportLedgerRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    target: row.target,
    pluginId: row.pluginId ?? undefined,
    namespace: row.namespace ?? undefined,
    key: row.key ?? undefined,
    sourceWorldId: row.sourceWorldId,
    sourceId: row.sourceId,
    sourceDigest: row.sourceDigest,
    valueHash: row.valueHash,
    schemaRef: row.schemaRef ?? undefined,
    derivedFrom:
      row.derivedFrom == null
        ? undefined
        : ((row.derivedFrom as string[] | null) ?? []),
    importedAt: row.importedAt,
    managed: row.managed !== 0,
  };
}

export function toLorebookEntryRecord(
  row: typeof schema.lorebookEntries.$inferSelect,
): LorebookEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    keys: ((row.keys as string[] | null) ?? []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord["strategy"],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: row.enabled !== 0,
    extra: row.extra == null ? undefined : row.extra,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSessionSummaryRecord(
  row: typeof schema.sessionSummaries.$inferSelect,
): SessionSummaryRecord {
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

export function toSnapshotRecord(
  row: typeof schema.stateSnapshots.$inferSelect,
): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    kind: row.kind as SnapshotKind,
    parentId: row.parentId ?? undefined,
    payload: (row.payload ?? {}) as SnapshotPayload,
    createdAt: row.createdAt,
  };
}

export function toSuspensionRecord(
  row: typeof schema.suspensions.$inferSelect,
): SuspensionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeId: row.runtimeId,
    pluginId: row.pluginId,
    reason: row.reason,
    resumeSchema: row.resumeSchema ?? null,
    pendingContinuation: (row.pendingContinuation ??
      {}) as SuspensionRecord["pendingContinuation"],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
