/**
 * Drizzle ORM schema for PostgreSQL backend.
 *
 * Keep this table-for-table aligned with `../sqlite/schema.ts`; the contract
 * suite (`store-contract.ts`) runs against both. Backend-specific differences
 * to watch when editing either file:
 *
 * - JSON columns: PG uses native `jsonb` (no app-layer (de)serialization);
 *   SQLite stores the same data as `text` and (de)serializes at the mapper
 *   layer. Write jsonb via `sql.json(value)` — never `JSON.stringify()`.
 * - JSON defaults: PG uses native literals (`.default([])` / `.default({})`);
 *   SQLite uses JSON strings (`.default("[]")` / `.default("{}")`).
 * - Binary (media_assets): PG stores bytes inline in a `bytea` column (`body`);
 *   SQLite stores only a filesystem `path` and keeps bytes on disk.
 * - Booleans: both backends model 0/1 as `integer` for parity.
 */

import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  jsonb,
  serial,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer | null }>({
  dataType() {
    return "bytea";
  },
});

// ── Worlds (not session-scoped) ─────────────────────────────────

export const worlds = pgTable("worlds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  lore: text("lore"),
  tags: jsonb("tags"), // JSON string[]
  locale: text("locale"),
  metadata: jsonb("metadata"), // JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

// ── Sessions ────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  worldId: text("world_id"),
  status: text("status").notNull().default("active"),
  turnCount: integer("turn_count").notNull().default(0),
  preGameCompleted: jsonb("pre_game_completed").notNull().default([]), // JSON string[] — runtimeIds that have finished pre-game band
  locale: text("locale").notNull().default("zh-CN"),
  activePlugins: jsonb("active_plugins").notNull().default([]), // JSON array
  metadata: jsonb("metadata"), // JSON
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  embeddingModelId: integer("embedding_model_id"), // FK → vector_models.id; NULL = RAG disabled
  embeddingLockedAt: text("embedding_locked_at"), // ISO 8601 timestamp
  runtimeModelOverrides: jsonb("runtime_model_overrides").default({}), // per-runtime slot overrides
  // Scheduling-redesign lifecycle fields (nullable; absent on legacy rows).
  phase: text("phase"), // 'setup' | 'playing'
  completedPlayerTurns: integer("completed_player_turns"),
  setupRuntimes: jsonb("setup_runtimes"), // Record<runtimeId, SetupRuntimeState>
});

// ── Turn Results ────────────────────────────────────────────────

export const turnResults = pgTable(
  "turn_results",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runtimeResults: jsonb("runtime_results").notNull(), // JSON
    conflicts: jsonb("conflicts"), // JSON
    auditResult: jsonb("audit_result"), // JSON
    // Execution origin (player/manual/follower/recursive) + parent
    // turn for recursive executions. NULL on legacy rows (= player).
    origin: text("origin"),
    parentTurnId: text("parent_turn_id"),
    commitStatus: text("commit_status"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_turn_results_session_id_idx").on(table.sessionId),
    index("pg_turn_results_turn_id_idx").on(table.turnId),
  ],
);

// ── Runtime Results ─────────────────────────────────────────────

export const runtimeResults = pgTable(
  "runtime_results",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    status: text("status").notNull(),
    output: jsonb("output"), // JSON
    toolCalls: jsonb("tool_calls"), // JSON
    durationMs: integer("duration_ms").notNull(),
    tokenUsage: jsonb("token_usage"), // JSON
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_runtime_results_session_id_idx").on(table.sessionId),
    index("pg_runtime_results_turn_id_idx").on(table.turnId),
  ],
);

// ── Tool Calls ──────────────────────────────────────────────────

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    toolName: text("tool_name").notNull(),
    pluginId: text("plugin_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    input: jsonb("input"), // JSON
    output: jsonb("output"), // JSON
    durationMs: integer("duration_ms").notNull(),
    approvalStatus: text("approval_status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_tool_calls_session_id_idx").on(table.sessionId),
    index("pg_tool_calls_turn_id_idx").on(table.turnId),
  ],
);

// ── State Schemas ───────────────────────────────────────────────

export const stateSchemas = pgTable(
  "state_schemas",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tableName: text("table_name").notNull(),
    schema: jsonb("schema").notNull(), // JSON
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("pg_state_schemas_session_id_idx").on(table.sessionId)],
);

// ── State Entries ───────────────────────────────────────────────

export const stateEntries = pgTable(
  "state_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tableName: text("table_name").notNull(),
    fieldName: text("field_name").notNull(),
    value: jsonb("value"), // JSON
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("pg_state_entries_session_id_idx").on(table.sessionId),
    index("pg_state_entries_composite_idx").on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
    uniqueIndex("pg_state_entries_unique_idx").on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── State Changes ───────────────────────────────────────────────

export const stateChanges = pgTable(
  "state_changes",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tableName: text("table_name").notNull(),
    fieldName: text("field_name").notNull(),
    value: jsonb("value"), // JSON
    changedBy: text("changed_by").notNull(),
    turnId: text("turn_id").notNull(),
    reason: text("reason"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_state_changes_session_id_idx").on(table.sessionId),
    index("pg_state_changes_composite_idx").on(
      table.sessionId,
      table.tableName,
      table.fieldName,
    ),
  ],
);

// ── Events ──────────────────────────────────────────────────────

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload"), // JSON
    targetRuntime: text("target_runtime"),
    turnId: text("turn_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_events_session_id_idx").on(table.sessionId),
    index("pg_events_topic_idx").on(table.sessionId, table.topic),
  ],
);

// ── Approvals ───────────────────────────────────────────────────

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    toolName: text("tool_name").notNull(),
    pluginId: text("plugin_id").notNull().default(""),
    decision: text("decision").notNull(),
    turnId: text("turn_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("pg_approvals_session_id_idx").on(table.sessionId)],
);

// ── Messages ────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"), // JSON
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_messages_session_id_idx").on(table.sessionId),
    // Supports the keyset page query (WHERE session_id = ? ORDER BY created_at
    // DESC … LIMIT) so a long chat log never scans every row to fetch a window.
    index("pg_messages_created_idx").on(table.sessionId, table.createdAt),
  ],
);

// ── Characters ──────────────────────────────────────────────────

export const characters = pgTable(
  "characters",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    description: text("description"),
    fields: jsonb("fields"), // JSON
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("pg_characters_session_id_idx").on(table.sessionId)],
);

// ── Plugin Data ─────────────────────────────────────────────────

export const pluginData = pgTable(
  "plugin_data",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value"), // JSON
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("pg_plugin_data_session_id_idx").on(table.sessionId),
    uniqueIndex("pg_plugin_data_unique_idx").on(
      table.sessionId,
      table.pluginId,
      table.namespace,
      table.key,
    ),
  ],
);

// ── World Data Import Ledger ────────────────────────────────────

export const worldDataImportLedger = pgTable(
  "world_data_import_ledger",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    target: text("target").notNull(),
    pluginId: text("plugin_id"),
    namespace: text("namespace"),
    key: text("key"),
    sourceWorldId: text("source_world_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    valueHash: text("value_hash").notNull(),
    schemaRef: text("schema_ref"),
    derivedFrom: jsonb("derived_from"),
    importedAt: text("imported_at").notNull(),
    managed: integer("managed").notNull().default(1),
  },
  (table) => [
    index("pg_world_data_import_ledger_session_id_idx").on(table.sessionId),
    index("pg_world_data_import_ledger_source_idx").on(
      table.sessionId,
      table.sourceWorldId,
      table.sourceId,
    ),
  ],
);

// ── Trace Events ────────────────────────────────────────────────

export const traceEvents = pgTable(
  "trace_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    traceId: text("trace_id").notNull(),
    turnId: text("turn_id").notNull(),
    payload: jsonb("payload"), // JSON
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_trace_events_session_id_idx").on(table.sessionId),
    index("pg_trace_events_trace_id_idx").on(table.sessionId, table.traceId),
    index("pg_trace_events_turn_id_idx").on(table.sessionId, table.turnId),
    // Supports the keyset page query on the fastest-growing table.
    index("pg_trace_events_created_idx").on(table.sessionId, table.createdAt),
  ],
);

// ── Runtime Outputs (translation layer) ────────────────────

export const runtimeOutputs = pgTable(
  "runtime_outputs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runtimeResultId: text("runtime_result_id"),
    pluginId: text("plugin_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    timestamp: text("timestamp").notNull(),
    results: jsonb("results").notNull(), // JSON — RuntimeOutputResult[]
    metaData: jsonb("meta_data").notNull(), // JSON — RuntimeOutputMetaData
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_runtime_outputs_session_time_idx").on(
      table.sessionId,
      table.timestamp,
    ),
    index("pg_runtime_outputs_runtime_idx").on(
      table.sessionId,
      table.runtimeId,
    ),
    index("pg_runtime_outputs_plugin_idx").on(table.sessionId, table.pluginId),
  ],
);

// ── Interaction Records (translation layer) ────────────────

export const interactionRecords = pgTable(
  "interaction_records",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    timestamp: text("timestamp").notNull(),
    source: text("source").notNull(),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    targetPluginId: text("target_plugin_id"),
    targetRuntimeId: text("target_runtime_id"),
    payload: jsonb("payload").notNull(),
    metaData: jsonb("meta_data"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_interaction_records_session_time_idx").on(
      table.sessionId,
      table.timestamp,
    ),
    index("pg_interaction_records_type_idx").on(table.sessionId, table.type),
  ],
);

// ── Turn Messages (append-only) ────────────────────────────────

export const turnMessages = pgTable(
  "turn_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourcePluginId: text("source_plugin_id"),
    sourceRuntimeId: text("source_runtime_id"),
    role: text("role").notNull(),
    name: text("name"),
    content: text("content").notNull(),
    ui: jsonb("ui"), // JSON
    pendingInput: jsonb("pending_input"), // JSON
    order: integer("order").notNull(),
    createdAt: text("created_at").notNull(),
    compactedAtTurnId: text("compacted_at_turn_id"), // summaryId — null = not compacted
  },
  (table) => [
    index("pg_turn_messages_session_id_idx").on(table.sessionId),
    index("pg_turn_messages_turn_id_idx").on(table.sessionId, table.turnId),
  ],
);

// ── Session Summaries (Compactor) ────────────────────────

export const sessionSummaries = pgTable(
  "session_summaries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnRangeStart: text("turn_range_start").notNull(),
    turnRangeEnd: text("turn_range_end").notNull(),
    content: text("content").notNull(),
    focusSections: jsonb("focus_sections").notNull().default([]), // JSON string[]
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("pg_session_summaries_session_id_idx").on(table.sessionId)],
);

// ── Player Inputs ──────────────────────────────────────────────

export const playerInputs = pgTable(
  "player_inputs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    formId: text("form_id").notNull(),
    values: jsonb("values").notNull(), // JSON
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("pg_player_inputs_session_id_idx").on(table.sessionId)],
);

// ── Working Memory ────────────────────────────────────

export const workingMemory = pgTable(
  "working_memory",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    key: text("key").notNull(),
    scope: text("scope").notNull(), // 'player' | 'story' | 'shared'
    value: jsonb("value"), // JSON
    schemaRef: text("schema_ref"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("pg_working_memory_session_id_idx").on(table.sessionId),
    uniqueIndex("pg_working_memory_unique_idx").on(
      table.sessionId,
      table.scope,
      table.key,
    ),
  ],
);

// ── Lorebook Entries ──────────────────────────────────

export const lorebookEntries = pgTable(
  "lorebook_entries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    keys: jsonb("keys").notNull(), // JSON string[]
    content: text("content").notNull(),
    strategy: text("strategy").notNull(), // 'constant' | 'selective'
    position: text("position").notNull(),
    insertionOrder: integer("insertion_order").notNull().default(100),
    enabled: integer("enabled").notNull().default(1), // 0/1
    extra: jsonb("extra"), // JSON | null
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("pg_lorebook_entries_session_id_idx").on(table.sessionId),
    index("pg_lorebook_entries_plugin_id_idx").on(
      table.sessionId,
      table.pluginId,
    ),
  ],
);

// ── State Snapshots ────────────────────────────────────

export const stateSnapshots = pgTable(
  "state_snapshots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    kind: text("kind").notNull(), // 'auto' | 'manual' | 'fork'
    parentId: text("parent_id"), // null except for kind='fork'
    payload: jsonb("payload").notNull(), // SnapshotPayload
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("pg_state_snapshots_session_id_idx").on(table.sessionId)],
);

// ── Media Assets ───────────────────────────────────────────────

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    body: bytea("body"),
    path: text("path"),
    objectKey: text("object_key"),
    meta: jsonb("meta"),
    ownerSessionId: text("owner_session_id"),
    ownerPluginId: text("owner_plugin_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("pg_media_assets_sha256_idx").on(table.sha256),
    index("pg_media_assets_owner_idx").on(
      table.ownerSessionId,
      table.ownerPluginId,
    ),
  ],
);

export const mediaRefs = pgTable(
  "media_refs",
  {
    sessionId: text("session_id").notNull(),
    mediaId: text("media_id").notNull(),
    pluginId: text("plugin_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("pg_media_refs_session_id_idx").on(table.sessionId),
    index("pg_media_refs_media_id_idx").on(table.mediaId),
    // UNIQUE on (sessionId, mediaId) only — see DDL comment in
    // pg-store-mappers.ts. plugin_id is "first-source metadata", not part of
    // the key, so addRef is idempotent regardless of pluginId.
    uniqueIndex("pg_media_refs_unique_idx").on(table.sessionId, table.mediaId),
  ],
);

// ── Suspensions ────────────────────────────────────────

export const suspensions = pgTable(
  "suspensions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    reason: text("reason").notNull(),
    resumeSchema: jsonb("resume_schema").notNull(), // JSON schema object
    pendingContinuation: jsonb("pending_continuation").notNull(), // serialized continuation state
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"), // nullable — set on resume
  },
  (table) => [index("pg_suspensions_session_id_idx").on(table.sessionId)],
);

// ── Logical Turn Ledger (scheduling redesign) ──────────────────
//
// Idempotency ledger: the (session_id, logical_turn_id) unique index is the
// "count this logical turn at most once" guarantee (insert-ignore on conflict).
// No surrogate PK — the composite unique key is the identity.

export const logicalTurnLedger = pgTable(
  "logical_turn_ledger",
  {
    sessionId: text("session_id").notNull(),
    logicalTurnId: text("logical_turn_id").notNull(),
    completedByExecutionId: text("completed_by_execution_id").notNull(),
    completedAt: text("completed_at").notNull(),
  },
  (table) => [
    uniqueIndex("pg_logical_turn_ledger_unique_idx").on(
      table.sessionId,
      table.logicalTurnId,
    ),
  ],
);

// ── Setup Attempts (scheduling redesign) ───────────────────────
//
// Setup-runtime attempt log. Unique on
// (session_id, runtime_id, generation, execution_id) — insert is idempotent,
// then the attempt is terminalised in place (state / finished_at / error).

export const setupAttempts = pgTable(
  "setup_attempts",
  {
    sessionId: text("session_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    generation: integer("generation").notNull(),
    executionId: text("execution_id").notNull(),
    state: text("state").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("pg_setup_attempts_unique_idx").on(
      table.sessionId,
      table.runtimeId,
      table.generation,
      table.executionId,
    ),
  ],
);

// ── Job Status (scheduling redesign) ───────────────────────────
//
// Append-only background-job progress stream. Unique on the full
// (session_id, progress_scope_id, plugin_id, runtime_id, job_id, sequence) key —
// a duplicate (job_id, sequence) is rejected (append-only, earlier event wins).

export const jobStatus = pgTable(
  "job_status",
  {
    sessionId: text("session_id").notNull(),
    progressScopeId: text("progress_scope_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    jobId: text("job_id").notNull(),
    state: text("state").notNull(),
    progress: doublePrecision("progress"), // float — undecided scale, stored lossless
    message: text("message"),
    data: jsonb("data"), // JsonValue payload
    sequence: integer("sequence").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("pg_job_status_unique_idx").on(
      table.sessionId,
      table.progressScopeId,
      table.pluginId,
      table.runtimeId,
      table.jobId,
      table.sequence,
    ),
  ],
);

// ── Runtime Exports (scheduling redesign) ──────────────────────
//
// `output.recordAs` publications: session-scoped, read-only, cross-plugin,
// versioned. Unique on (session_id, producer_runtime_id, record_as, revision) —
// insert-ignore on conflict, so a re-published revision is a no-op. `value` is a
// required JsonValue but stored as a NULLABLE jsonb column (a top-level JSON
// `null` serialises to SQL NULL and reads back as `null` via `readRequired`,
// exactly like `state_entries.value`). The unique index's left prefix
// (session_id, producer_runtime_id, record_as) also serves getLatest / list.

export const runtimeExports = pgTable(
  "runtime_exports",
  {
    sessionId: text("session_id").notNull(),
    producerPluginId: text("producer_plugin_id").notNull(),
    producerRuntimeId: text("producer_runtime_id").notNull(),
    recordAs: text("record_as").notNull(),
    revision: integer("revision").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    schemaDigest: text("schema_digest").notNull(),
    resultId: text("result_id").notNull(),
    value: jsonb("value"), // JsonValue (required field; nullable column)
    committedAt: text("committed_at").notNull(),
  },
  (table) => [
    uniqueIndex("pg_runtime_exports_unique_idx").on(
      table.sessionId,
      table.producerRuntimeId,
      table.recordAs,
      table.revision,
    ),
  ],
);

// ── Vector Models (per-model embedding isolation) ──────────────

export const vectorModels = pgTable(
  "vector_models",
  {
    id: serial("id").primaryKey(),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    modelName: text("model_name").notNull(),
    dim: integer("dim").notNull(),
    // Auto-filled by the schema-side trigger as 'vec_mem_m{id}'.
    // Application code MUST NOT set this on INSERT.
    tableName: text("table_name").notNull().default(""),
    // BIGINT to fit Date.now() (~1.7e12). PG `integer` is INT32, would overflow.
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("pg_vector_models_model_id_dim_idx").on(
      table.modelId,
      table.dim,
    ),
  ],
);
