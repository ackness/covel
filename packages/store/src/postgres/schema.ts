/**
 * Drizzle ORM schema for PostgreSQL backend.
 *
 * JSON fields use native `jsonb` type — no manual serialization needed.
 */

import { pgTable, text, integer, jsonb, index } from 'drizzle-orm/pg-core';

// ── Worlds (not session-scoped) ─────────────────────────────────

export const worlds = pgTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
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
  },
  (table) => [
    index('pg_turn_messages_session_id_idx').on(table.sessionId),
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
