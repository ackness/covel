/**
 * Drizzle ORM schema for SQLite backend.
 *
 * All JSON fields are stored as TEXT and serialized/deserialized
 * at the application layer.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// ── Worlds (not session-scoped) ─────────────────────────────────

export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  locale: text('locale'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
});

// ── Sessions ────────────────────────────────────────────────────

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  worldId: text('world_id'),
  phase: text('phase').notNull(),
  turnCount: integer('turn_count').notNull().default(0),
  locale: text('locale').notNull().default('zh-CN'),
  activePlugins: text('active_plugins').notNull().default('[]'), // JSON
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  },
  (table) => [
    index('turn_messages_session_id_idx').on(table.sessionId),
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
