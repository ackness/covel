/**
 * Drizzle ORM schema for SQLite backend.
 *
 * All JSON fields are stored as TEXT and serialized/deserialized
 * at the application layer.
 */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── Worlds (not session-scoped) ─────────────────────────────────

export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  lore: text('lore'),
  tags: text('tags'), // JSON string[]
  locale: text('locale'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
});

// ── Sessions ────────────────────────────────────────────────────

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  worldId: text('world_id'),
  status: text('status').notNull().default('active'),
  turnCount: integer('turn_count').notNull().default(0),
  preGameCompleted: text('pre_game_completed').notNull().default('[]'), // JSON
  locale: text('locale').notNull().default('zh-CN'),
  activePlugins: text('active_plugins').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  embeddingModelId: integer('embedding_model_id'),
  embeddingLockedAt: text('embedding_locked_at'),
  runtimeModelOverrides: text('runtime_model_overrides').default('{}'),
});

// ── Turn Results ────────────────────────────────────────────────

export const turnResults = sqliteTable(
  'turn_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    runtimeResults: text('runtime_results').notNull(), // JSON
    conflicts: text('conflicts'),                       // JSON
    auditResult: text('audit_result'),                  // JSON
    durationMs: integer('duration_ms').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('turn_results_session_id_idx').on(table.sessionId),
    index('turn_results_turn_id_idx').on(table.turnId),
  ],
);

// ── Runtime Results ─────────────────────────────────────────────

export const runtimeResults = sqliteTable(
  'runtime_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    status: text('status').notNull(),
    output: text('output'),           // JSON
    toolCalls: text('tool_calls'),    // JSON
    durationMs: integer('duration_ms').notNull(),
    tokenUsage: text('token_usage'),  // JSON
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('runtime_results_session_id_idx').on(table.sessionId),
    index('runtime_results_turn_id_idx').on(table.turnId),
  ],
);

// ── Tool Calls ──────────────────────────────────────────────────

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    toolName: text('tool_name').notNull(),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    input: text('input'),   // JSON
    output: text('output'),  // JSON
    durationMs: integer('duration_ms').notNull(),
    approvalStatus: text('approval_status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('tool_calls_session_id_idx').on(table.sessionId),
    index('tool_calls_turn_id_idx').on(table.turnId),
  ],
);

// ── State Schemas ───────────────────────────────────────────────

export const stateSchemas = sqliteTable(
  'state_schemas',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    schema: text('schema').notNull(), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('state_schemas_session_id_idx').on(table.sessionId),
  ],
);

// ── State Entries ───────────────────────────────────────────────

export const stateEntries = sqliteTable(
  'state_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    fieldName: text('field_name').notNull(),
    value: text('value'),     // JSON
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('state_entries_session_id_idx').on(table.sessionId),
    index('state_entries_composite_idx').on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
    uniqueIndex('state_entries_unique_idx').on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── State Changes ───────────────────────────────────────────────

export const stateChanges = sqliteTable(
  'state_changes',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    tableName: text('table_name').notNull(),
    fieldName: text('field_name').notNull(),
    value: text('value'),     // JSON
    changedBy: text('changed_by').notNull(),
    turnId: text('turn_id').notNull(),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('state_changes_session_id_idx').on(table.sessionId),
    index('state_changes_composite_idx').on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── Events ──────────────────────────────────────────────────────

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    topic: text('topic').notNull(),
    payload: text('payload'), // JSON
    targetRuntime: text('target_runtime'),
    turnId: text('turn_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('events_session_id_idx').on(table.sessionId),
    index('events_topic_idx').on(table.sessionId, table.topic),
  ],
);

// ── Approvals ───────────────────────────────────────────────────

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    toolName: text('tool_name').notNull(),
    pluginId: text('plugin_id').notNull().default(''),
    decision: text('decision').notNull(),
    turnId: text('turn_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('approvals_session_id_idx').on(table.sessionId),
  ],
);

// ── Messages ────────────────────────────────────────────────────

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: text('metadata'), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('messages_session_id_idx').on(table.sessionId),
  ],
);

// ── Characters ──────────────────────────────────────────────────

export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    description: text('description'),
    fields: text('fields'),   // JSON
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('characters_session_id_idx').on(table.sessionId),
  ],
);

// ── Plugin Data ─────────────────────────────────────────────────

export const pluginData = sqliteTable(
  'plugin_data',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value'), // JSON
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('plugin_data_session_id_idx').on(table.sessionId),
    uniqueIndex('plugin_data_unique_idx').on(
      table.sessionId,
      table.pluginId,
      table.namespace,
      table.key,
    ),
  ],
);

// ── Plugin Configs ──────────────────────────────────────────────

export const pluginConfigs = sqliteTable(
  'plugin_configs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    config: text('config').notNull(), // JSON
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('plugin_configs_session_id_idx').on(table.sessionId),
    index('plugin_configs_composite_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── Trace Events ────────────────────────────────────────────────

export const traceEvents = sqliteTable(
  'trace_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    traceId: text('trace_id').notNull(),
    turnId: text('turn_id').notNull(),
    payload: text('payload'), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('trace_events_session_id_idx').on(table.sessionId),
    index('trace_events_trace_id_idx').on(table.sessionId, table.traceId),
    index('trace_events_turn_id_idx').on(table.sessionId, table.turnId),
  ],
);

// ── Runtime Outputs (PR-1 translation layer) ────────────────────

export const runtimeOutputs = sqliteTable(
  'runtime_outputs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    runtimeResultId: text('runtime_result_id'),
    pluginId: text('plugin_id').notNull(),
    runtimeId: text('runtime_id').notNull(),
    timestamp: text('timestamp').notNull(),
    results: text('results').notNull(),     // JSON string
    metaData: text('meta_data').notNull(),  // JSON string
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('runtime_outputs_session_time_idx').on(table.sessionId, table.timestamp),
    index('runtime_outputs_runtime_idx').on(table.sessionId, table.runtimeId),
    index('runtime_outputs_plugin_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── Interaction Records (PR-1 translation layer) ────────────────

export const interactionRecords = sqliteTable(
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
    payload: text('payload').notNull(),   // JSON string
    metaData: text('meta_data'),          // JSON string | null
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('interaction_records_session_time_idx').on(table.sessionId, table.timestamp),
    index('interaction_records_type_idx').on(table.sessionId, table.type),
  ],
);

// ── Turn Messages (append-only) ────────────────────────────────

export const turnMessages = sqliteTable(
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
    ui: text('ui'),               // JSON
    pendingInput: text('pending_input'), // JSON
    order: integer('order').notNull(),
    createdAt: text('created_at').notNull(),
    compactedAtTurnId: text('compacted_at_turn_id'), // summaryId — null = not compacted
  },
  (table) => [
    index('turn_messages_session_id_idx').on(table.sessionId),
    index('turn_messages_turn_id_idx').on(table.sessionId, table.turnId),
  ],
);

// ── Session Summaries (S2-T2 Compactor) ────────────────────────

export const sessionSummaries = sqliteTable(
  'session_summaries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnRangeStart: text('turn_range_start').notNull(),
    turnRangeEnd: text('turn_range_end').notNull(),
    content: text('content').notNull(),
    focusSections: text('focus_sections').notNull().default('[]'), // JSON string[]
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('session_summaries_session_id_idx').on(table.sessionId),
  ],
);

// ── Player Inputs ──────────────────────────────────────────────

export const playerInputs = sqliteTable(
  'player_inputs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id').notNull(),
    formId: text('form_id').notNull(),
    values: text('values').notNull(), // JSON
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('player_inputs_session_id_idx').on(table.sessionId),
  ],
);

// ── Working Memory (S3-T3) ────────────────────────────────────

export const workingMemory = sqliteTable(
  'working_memory',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    key: text('key').notNull(),
    scope: text('scope').notNull(),    // 'player' | 'story' | 'shared'
    value: text('value').notNull(),    // JSON
    schemaRef: text('schema_ref'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('working_memory_session_id_idx').on(table.sessionId),
    uniqueIndex('working_memory_unique_idx').on(
      table.sessionId,
      table.scope,
      table.key,
    ),
  ],
);

// ── Media Assets (content-addressable bytes) ───────────────────

export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    path: text('path').notNull(),
    meta: text('meta'), // JSON
    ownerSessionId: text('owner_session_id'),
    ownerPluginId: text('owner_plugin_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('media_assets_sha256_idx').on(table.sha256),
    index('media_assets_owner_idx').on(table.ownerSessionId, table.ownerPluginId),
  ],
);

export const mediaRefs = sqliteTable(
  'media_refs',
  {
    sessionId: text('session_id').notNull(),
    mediaId: text('media_id').notNull(),
    pluginId: text('plugin_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('media_refs_session_id_idx').on(table.sessionId),
    index('media_refs_media_id_idx').on(table.mediaId),
    uniqueIndex('media_refs_unique_idx').on(table.sessionId, table.mediaId, table.pluginId),
  ],
);

// ── Lorebook Entries (S3-T2) ──────────────────────────────────

export const lorebookEntries = sqliteTable(
  'lorebook_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    pluginId: text('plugin_id').notNull(),
    keys: text('keys').notNull(),       // JSON string[]
    content: text('content').notNull(),
    strategy: text('strategy').notNull(), // 'constant' | 'selective'
    position: text('position').notNull(),
    insertionOrder: integer('insertion_order').notNull().default(100),
    enabled: integer('enabled').notNull().default(1), // 0/1
    extra: text('extra'),                // JSON | null
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('lorebook_entries_session_id_idx').on(table.sessionId),
    index('lorebook_entries_plugin_id_idx').on(table.sessionId, table.pluginId),
  ],
);

// ── Vector Models (per-model embedding isolation) ──────────────

export const vectorModels = sqliteTable('vector_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelId: text('model_id').notNull(),       // "openai/text-embedding-3-small"
  provider: text('provider').notNull(),      // "openai"
  modelName: text('model_name').notNull(),   // "text-embedding-3-small"
  dim: integer('dim').notNull(),             // 1536
  // Auto-filled by the schema-side trigger as 'vec_mem_m{id}'.
  // Application code MUST NOT set this on INSERT.
  tableName: text('table_name').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
}, (table) => [
  uniqueIndex('vector_models_model_id_dim_idx').on(table.modelId, table.dim),
]);
