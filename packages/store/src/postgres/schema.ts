/**
 * Drizzle ORM schema for PostgreSQL backend.
 *
 * JSON fields use native `jsonb` type — no manual serialization needed.
 */

import { pgTable, text, integer, bigint, jsonb, serial, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ── Worlds (not session-scoped) ─────────────────────────────────

export const worlds = pgTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  lore: text('lore'),
  tags: jsonb('tags'), // JSON string[]
  locale: text('locale'),
  metadata: jsonb('metadata'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
});

// ── Sessions ────────────────────────────────────────────────────

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  worldId: text('world_id'),
  phase: text('phase').notNull(),
  turnCount: integer('turn_count').notNull().default(0),
  locale: text('locale').notNull().default('zh-CN'),
  activePlugins: jsonb('active_plugins').notNull().default([]), // JSON array
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  embeddingModelId: integer('embedding_model_id'),    // FK → vector_models.id; NULL = RAG disabled
  embeddingLockedAt: text('embedding_locked_at'),     // ISO 8601 timestamp
  playingTurnOffset: integer('playing_turn_offset'),  // PR-2: turnNumber at first playing-phase entry
  runtimeModelOverrides: jsonb('runtime_model_overrides').default({}), // PR-6: per-runtime slot overrides
});

// ── Turn Results ────────────────────────────────────────────────

export const turnResults = pgTable(
  'turn_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    runtimeResults: jsonb('runtime_results').notNull(), // JSON
    conflicts: jsonb('conflicts'),                       // JSON
    auditResult: jsonb('audit_result'),                  // JSON
    durationMs: integer('duration_ms').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_turn_results_session_id_idx').on(table.sessionId),
    index('pg_turn_results_turn_id_idx').on(table.turnId),
  ],
);

// ── Runtime Results ─────────────────────────────────────────────

export const runtimeResults = pgTable(
  'runtime_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    status: text('status').notNull(),
    output: jsonb('output'),           // JSON
    toolCalls: jsonb('tool_calls'),    // JSON
    durationMs: integer('duration_ms').notNull(),
    tokenUsage: jsonb('token_usage'),  // JSON
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_runtime_results_session_id_idx').on(table.sessionId),
    index('pg_runtime_results_turn_id_idx').on(table.turnId),
  ],
);

// ── Tool Calls ──────────────────────────────────────────────────

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolName: text('tool_name').notNull(),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    input: jsonb('input'),   // JSON
    output: jsonb('output'),  // JSON
    durationMs: integer('duration_ms').notNull(),
    approvalStatus: text('approval_status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_tool_calls_session_id_idx').on(table.sessionId),
    index('pg_tool_calls_turn_id_idx').on(table.turnId),
  ],
);

// ── State Schemas ───────────────────────────────────────────────

export const stateSchemas = pgTable(
  'state_schemas',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    schema: jsonb('schema').notNull(), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_state_schemas_session_id_idx').on(table.sessionId),
  ],
);

// ── State Entries ───────────────────────────────────────────────

export const stateEntries = pgTable(
  'state_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    fieldName: text('field_name').notNull(),
    value: jsonb('value'),     // JSON
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_state_entries_session_id_idx').on(table.sessionId),
    index('pg_state_entries_composite_idx').on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── State Changes ───────────────────────────────────────────────

export const stateChanges = pgTable(
  'state_changes',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    fieldName: text('field_name').notNull(),
    value: jsonb('value'),     // JSON
    changedBy: text('changed_by').notNull(),
    turnId: text('turn_id').notNull(),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_state_changes_session_id_idx').on(table.sessionId),
    index('pg_state_changes_composite_idx').on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── Events ──────────────────────────────────────────────────────

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    topic: text('topic').notNull(),
    payload: jsonb('payload'), // JSON
    targetRuntime: text('target_runtime'),
    turnId: text('turn_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_events_session_id_idx').on(table.sessionId),
    index('pg_events_topic_idx').on(table.sessionId, table.topic),
  ],
);

// ── Approvals ───────────────────────────────────────────────────

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    decision: text('decision').notNull(),
    turnId: text('turn_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_approvals_session_id_idx').on(table.sessionId),
  ],
);

// ── Messages ────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata'), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_messages_session_id_idx').on(table.sessionId),
  ],
);

// ── Characters ──────────────────────────────────────────────────

export const characters = pgTable(
  'characters',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    fields: jsonb('fields'),   // JSON
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_characters_session_id_idx').on(table.sessionId),
  ],
);

// ── Plugin Data ─────────────────────────────────────────────────

export const pluginData = pgTable(
  'plugin_data',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: jsonb('value'), // JSON
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_plugin_data_session_id_idx').on(table.sessionId),
    uniqueIndex('pg_plugin_data_unique_idx').on(
      table.sessionId,
      table.pluginId,
      table.namespace,
      table.key,
    ),
  ],
);

// ── Plugin Configs ──────────────────────────────────────────────

export const pluginConfigs = pgTable(
  'plugin_configs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    config: jsonb('config').notNull(), // JSON
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_plugin_configs_session_id_idx').on(table.sessionId),
    index('pg_plugin_configs_composite_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── Trace Events ────────────────────────────────────────────────

export const traceEvents = pgTable(
  'trace_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    traceId: text('trace_id').notNull(),
    turnId: text('turn_id').notNull(),
    payload: jsonb('payload'), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_trace_events_session_id_idx').on(table.sessionId),
    index('pg_trace_events_trace_id_idx').on(table.sessionId, table.traceId),
    index('pg_trace_events_turn_id_idx').on(table.sessionId, table.turnId),
  ],
);

// ── Runtime Outputs (PR-1 translation layer) ────────────────────

export const runtimeOutputs = pgTable(
  'runtime_outputs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    runtimeResultId: text('runtime_result_id'),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    timestamp: text('timestamp').notNull(),
    results: jsonb('results').notNull(),    // JSON — RuntimeOutputResult[]
    metaData: jsonb('meta_data').notNull(), // JSON — RuntimeOutputMetaData
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_runtime_outputs_session_time_idx').on(table.sessionId, table.timestamp),
    index('pg_runtime_outputs_runtime_idx').on(table.sessionId, table.runtimeId),
    index('pg_runtime_outputs_plugin_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── Interaction Records (PR-1 translation layer) ────────────────

export const interactionRecords = pgTable(
  'interaction_records',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    timestamp: text('timestamp').notNull(),
    source: text('source').notNull(),
    channel: text('channel').notNull(),
    type: text('type').notNull(),
    targetPluginId: text('target_plugin_id'),
    targetRuntimeId: text('target_runtime_id'),
    payload: jsonb('payload').notNull(),
    metaData: jsonb('meta_data'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_interaction_records_session_time_idx').on(table.sessionId, table.timestamp),
    index('pg_interaction_records_type_idx').on(table.sessionId, table.type),
  ],
);

// ── Turn Messages (append-only) ────────────────────────────────

export const turnMessages = pgTable(
  'turn_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourcePluginId: text('source_plugin_id'),
    sourceRuntimeId: text('source_runtime_id'),
    role: text('role').notNull(),
    name: text('name'),
    content: text('content').notNull(),
    ui: jsonb('ui'),               // JSON
    pendingInput: jsonb('pending_input'), // JSON
    order: integer('order').notNull(),
    createdAt: text('created_at').notNull(),
    compactedAtTurnId: text('compacted_at_turn_id'), // summaryId — null = not compacted
  },
  (table) => [
    index('pg_turn_messages_session_id_idx').on(table.sessionId),
    index('pg_turn_messages_turn_id_idx').on(table.sessionId, table.turnId),
  ],
);

// ── Session Summaries (S2-T2 Compactor) ────────────────────────

export const sessionSummaries = pgTable(
  'session_summaries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnRangeStart: text('turn_range_start').notNull(),
    turnRangeEnd: text('turn_range_end').notNull(),
    content: text('content').notNull(),
    focusSections: jsonb('focus_sections').notNull().default([]), // JSON string[]
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_session_summaries_session_id_idx').on(table.sessionId),
  ],
);

// ── Player Inputs ──────────────────────────────────────────────

export const playerInputs = pgTable(
  'player_inputs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    formId: text('form_id').notNull(),
    values: jsonb('values').notNull(), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_player_inputs_session_id_idx').on(table.sessionId),
  ],
);

// ── Working Memory (S3-T3) ────────────────────────────────────

export const workingMemory = pgTable(
  'working_memory',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    key: text('key').notNull(),
    scope: text('scope').notNull(),    // 'player' | 'story' | 'shared'
    value: jsonb('value').notNull(),   // JSON
    schemaRef: text('schema_ref'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_working_memory_session_id_idx').on(table.sessionId),
    uniqueIndex('pg_working_memory_unique_idx').on(
      table.sessionId,
      table.scope,
      table.key,
    ),
  ],
);

// ── Lorebook Entries (S3-T2) ──────────────────────────────────

export const lorebookEntries = pgTable(
  'lorebook_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    keys: jsonb('keys').notNull(),         // JSON string[]
    content: text('content').notNull(),
    strategy: text('strategy').notNull(),  // 'constant' | 'selective'
    position: text('position').notNull(),
    insertionOrder: integer('insertion_order').notNull().default(100),
    enabled: integer('enabled').notNull().default(1), // 0/1
    extra: jsonb('extra'),                 // JSON | null
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('pg_lorebook_entries_session_id_idx').on(table.sessionId),
    index('pg_lorebook_entries_plugin_id_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── State Snapshots (S4-T2) ────────────────────────────────────

export const stateSnapshots = pgTable(
  'state_snapshots',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    kind: text('kind').notNull(),                 // 'auto' | 'manual' | 'fork'
    parentId: text('parent_id'),                  // null except for kind='fork'
    payload: jsonb('payload').notNull(),          // SnapshotPayload
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('pg_state_snapshots_session_id_idx').on(table.sessionId),
  ],
);

// ── Suspensions (S4-T4) ────────────────────────────────────────

export const suspensions = pgTable(
  'suspensions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    reason: text('reason').notNull(),
    resumeSchema: jsonb('resume_schema').notNull(),          // JSON schema object
    pendingContinuation: jsonb('pending_continuation').notNull(), // serialized continuation state
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),                         // nullable — set on resume
  },
  (table) => [
    index('pg_suspensions_session_id_idx').on(table.sessionId),
  ],
);

// ── Vector Models (per-model embedding isolation) ──────────────

export const vectorModels = pgTable('vector_models', {
  id: serial('id').primaryKey(),
  modelId: text('model_id').notNull(),
  provider: text('provider').notNull(),
  modelName: text('model_name').notNull(),
  dim: integer('dim').notNull(),
  // Auto-filled by the schema-side trigger as 'vec_mem_m{id}'.
  // Application code MUST NOT set this on INSERT.
  tableName: text('table_name').notNull().default(''),
  // BIGINT to fit Date.now() (~1.7e12). PG `integer` is INT32, would overflow.
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastUsedAt: bigint('last_used_at', { mode: 'number' }),
}, (table) => [
  uniqueIndex('pg_vector_models_model_id_dim_idx').on(table.modelId, table.dim),
]);
