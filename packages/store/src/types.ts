/**
 * Unified DataStore interface and record types.
 *
 * All data is session-scoped. Switching backends requires only changing
 * the STORE_BACKEND environment variable (memory | sqlite | pg).
 */

import type { SessionStatus } from '@covel/shared';

// ── Record types ─────────────────────────────────────────────────

export interface WorldRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly worldId?: string;
  /** Lifecycle flag — `active` / `paused` / `ended`. */
  readonly status: SessionStatus;
  /** Band selector — 0 = Pre-Game (only priority 0-99 scheduled, may iterate);
   *  >=1 = main loop (only priority 100-1000). Advances from 0 → 1 when all
   *  Pre-Game runtimes report done. */
  readonly turnCount: number;
  /** RuntimeIds of Pre-Game runtimes that have completed. Used to gate the
   *  turnCount 0 → 1 transition. */
  readonly preGameCompleted: readonly string[];
  readonly locale: string;
  readonly activePlugins: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** FK to vector_models.id; null = RAG disabled */
  readonly embeddingModelId?: number | null;
  /** ISO 8601 timestamp; null = not locked */
  readonly embeddingLockedAt?: string | null;
  /**
   * PR-6: Per-runtime model slot overrides. Maps runtime ID
   * (`pluginId` or `pluginId/runtimeName`) → slot name from `llm.toml`.
   * Empty/undefined means no overrides — slot resolution falls back to
   * `manifest.model` then `"default"`.
   */
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
}

export interface TurnResultRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeResults: unknown; // JSON — RuntimeResult[]
  readonly conflicts?: unknown;     // JSON — WriteConflict[]
  readonly auditResult?: unknown;   // JSON — RuntimeResult
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface RuntimeResultRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly status: string;
  readonly output: unknown;        // JSON
  readonly toolCalls: unknown;     // JSON — ToolCallRecord[]
  readonly durationMs: number;
  readonly tokenUsage?: unknown;   // JSON — { input, output }
  readonly error?: string;
  readonly createdAt: string;
}

export interface ToolCallRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly input: unknown;         // JSON
  readonly output: unknown;        // JSON
  readonly durationMs: number;
  readonly approvalStatus: string;
  readonly createdAt: string;
}

export interface StateSchemaRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly schema: unknown;        // JSON — StateTableSchema
  readonly createdAt: string;
}

export interface StateEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly value: unknown;         // JSON
  readonly updatedAt: string;
}

export interface StateChangeRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly value: unknown;         // JSON
  readonly changedBy: string;
  readonly turnId: string;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface EventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly topic: string;
  readonly payload: unknown;       // JSON
  readonly targetRuntime?: string;
  readonly turnId?: string;
  readonly createdAt: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly decision: string;
  readonly turnId: string;
  readonly createdAt: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly content: string;
  readonly metadata?: unknown;     // JSON
  readonly createdAt: string;
}

export interface CharacterRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;       // JSON
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginDataRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;           // JSON
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginConfigRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly config: unknown;        // JSON
  readonly updatedAt: string;
}

export interface WorkingMemoryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly key: string;
  readonly scope: 'player' | 'story' | 'shared';
  readonly value: unknown;        // validated by schema_ref when present
  readonly schemaRef?: string;
  readonly updatedAt: string;     // ISO
}

/**
 * Session-scoped lorebook entry persisted to the store (S3-T2).
 *
 * Plain record shape carrying all lorebook entry fields. The framework
 * routes and runtime/loader handle field-level semantics; the store layer
 * just persists and retrieves these records by (sessionId, id).
 *
 * Only session-source entries land here. World/plugin layer entries are
 * loaded from disk by the lorebook loaders and never persisted via this
 * table — A3 keeps them as authoring artefacts, not session state.
 */
export interface LorebookEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  /** Plugin that owns this entry. Mirrors lorebook `pluginId` for traceability. */
  readonly pluginId: string;
  /** JSON string[] — keys for selective scanning (constant entries can pass `[]`). */
  readonly keys: readonly string[];
  readonly content: string;
  readonly strategy: 'constant' | 'selective';
  readonly position: string;            // LorebookPosition — keep stringly-typed at the store edge
  readonly insertionOrder: number;
  readonly enabled: boolean;
  /** Free-form JSON for forward-compatible fields (atDepth, budgetCap, etc.). */
  readonly extra?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TraceEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly traceId: string;
  readonly turnId: string;
  readonly payload: unknown;       // JSON
  readonly createdAt: string;
}

// ── Translation layer: RuntimeOutput + InteractionRecord (PR-1) ──

/**
 * Normalised record of one runtime execution's output. Written by
 * `turn-executor` after each runtime finishes. Consumers include downstream
 * runtimes (via `results[].text` as context), frontends (via
 * `results[].structured`), and observability tooling (via `metaData`).
 *
 * Paired with `trace_events` — this table is the normalised/consumable layer,
 * `trace_events` remains the low-level debug timeline.
 */
export interface RuntimeOutputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Optional FK back to `runtime_results.id`. */
  readonly runtimeResultId?: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly timestamp: string;
  /** JSON — readonly RuntimeOutputResult[] */
  readonly results: unknown;
  /** JSON — RuntimeOutputMetaData */
  readonly metaData: unknown;
  readonly createdAt: string;
}

/**
 * Normalised record of one external input (player message, plugin UI click,
 * form submit, RPC call, external skill invocation). Complements
 * `RuntimeOutputRecord` — the two together form the complete event stream
 * of a session for observability and replay.
 */
export interface InteractionRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly timestamp: string;
  readonly source: string;
  readonly channel: string;
  readonly type: string;
  readonly targetPluginId?: string;
  readonly targetRuntimeId?: string;
  readonly payload: unknown;       // JSON
  readonly metaData?: unknown;     // JSON
  readonly createdAt: string;
}

export interface RuntimeOutputFilters {
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly sinceTimestamp?: string;
  readonly limit?: number;
}

export interface InteractionRecordFilters {
  readonly type?: string;
  readonly source?: string;
  readonly targetPluginId?: string;
  readonly limit?: number;
}

// ── Pagination ──────────────────────────────────────────────────

export interface PaginationOpts {
  /** Max rows to return. Default varies by method. */
  readonly limit?: number;
  /** Number of rows to skip. Default: 0. */
  readonly offset?: number;
}

// ── DataStore interface ──────────────────────────────────────────

export interface DataStore {
  // ── Session ──
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(id: string, patch: Partial<Pick<SessionRecord, 'status' | 'turnCount' | 'preGameCompleted' | 'activePlugins' | 'updatedAt' | 'embeddingModelId' | 'embeddingLockedAt' | 'runtimeModelOverrides'>>): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;

  // ── Turn Results ──
  saveTurnResult(record: TurnResultRecord): Promise<void>;
  getTurnResult(sessionId: string, turnId: string): Promise<TurnResultRecord | null>;
  listTurnResults(sessionId: string, limit?: number): Promise<TurnResultRecord[]>;

  // ── Runtime Results ──
  saveRuntimeResult(record: RuntimeResultRecord): Promise<void>;
  listRuntimeResults(sessionId: string, turnId: string): Promise<RuntimeResultRecord[]>;

  // ── Tool Calls ──
  saveToolCall(record: ToolCallRecordRow): Promise<void>;
  listToolCalls(sessionId: string, turnId?: string): Promise<ToolCallRecordRow[]>;

  // ── Runtime Outputs (PR-1 translation layer) ──
  saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void>;
  getRuntimeOutput(sessionId: string, id: string): Promise<RuntimeOutputRecord | null>;
  listRuntimeOutputs(
    sessionId: string,
    filters?: RuntimeOutputFilters,
  ): Promise<RuntimeOutputRecord[]>;

  // ── Interaction Records (PR-1 translation layer) ──
  saveInteractionRecord(record: InteractionRecordRow): Promise<void>;
  listInteractionRecords(
    sessionId: string,
    filters?: InteractionRecordFilters,
  ): Promise<InteractionRecordRow[]>;

  // ── State Schemas ──
  saveStateSchema(record: StateSchemaRecord): Promise<void>;
  listStateSchemas(sessionId: string): Promise<StateSchemaRecord[]>;
  deleteStateSchema(sessionId: string, tableName: string): Promise<void>;

  // ── State Entries ──
  getStateEntry(sessionId: string, tableName: string, fieldName: string): Promise<StateEntryRecord | null>;
  upsertStateEntry(record: StateEntryRecord): Promise<void>;
  listStateEntries(sessionId: string, tableName: string): Promise<StateEntryRecord[]>;

  // ── State Changes ──
  addStateChange(record: StateChangeRecord): Promise<void>;
  listStateChanges(sessionId: string, tableName: string, fieldName: string): Promise<StateChangeRecord[]>;

  // ── Events ──
  saveEvent(record: EventRecord): Promise<void>;
  listEvents(sessionId: string, options?: { topic?: string; limit?: number }): Promise<EventRecord[]>;

  // ── Approvals ──
  saveApproval(record: ApprovalRecord): Promise<void>;
  listApprovals(sessionId: string): Promise<ApprovalRecord[]>;

  // ── Messages ──
  addMessage(record: MessageRecord): Promise<void>;
  listMessages(sessionId: string, pagination?: PaginationOpts): Promise<MessageRecord[]>;

  // ── Characters ──
  upsertCharacter(record: CharacterRecord): Promise<void>;
  listCharacters(sessionId: string): Promise<CharacterRecord[]>;

  // ── Plugin Data ──
  setPluginData(record: PluginDataRecord): Promise<void>;
  setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void>;
  getPluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<PluginDataRecord | null>;
  listPluginData(sessionId: string, pluginId: string, namespace?: string, pagination?: PaginationOpts): Promise<PluginDataRecord[]>;
  /**
   * List every plugin_data row for a session across ALL pluginIds and
   * namespaces. Used by the snapshot payload builder (audit 2026-04-20
   * finding 7.2) so that plugins which wrote plugin_data without ever
   * producing a runtime result (install hooks, data-only providers,
   * plugins that suspended before completing) are not silently dropped
   * from the snapshot.
   *
   * Implementations should key off the `(sessionId)` index; the shape is
   * the same as `listPluginData`, just without the pluginId filter. The
   * plugin-scoped `listPluginData` remains the narrower, high-traffic API.
   */
  listPluginDataSessionScope(sessionId: string, pagination?: PaginationOpts): Promise<readonly PluginDataRecord[]>;
  deletePluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<void>;

  // ── Plugin Configs ──
  savePluginConfig(record: PluginConfigRecord): Promise<void>;
  getPluginConfig(sessionId: string, pluginId: string): Promise<PluginConfigRecord | null>;

  // ── Worlds ──
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  upsertWorld(record: WorldRecord): Promise<void>;
  deleteWorld(id: string): Promise<void>;

  // ── Trace ──
  addTraceEvent(record: TraceEventRecord): Promise<void>;
  listTraceEvents(sessionId: string, pagination?: PaginationOpts): Promise<TraceEventRecord[]>;

  // ── Turn Messages (append-only) ──
  appendTurnMessage(record: TurnMessageRecord): Promise<void>;
  listTurnMessages(sessionId: string, pagination?: PaginationOpts): Promise<TurnMessageRecord[]>;

  // ── Player Inputs ──
  savePlayerInput(record: PlayerInputRecord): Promise<void>;
  getPlayerInput(sessionId: string, formId: string): Promise<PlayerInputRecord | null>;
  listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]>;

  // ── Working Memory (S3-T3) ──
  upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void>;
  getWorkingMemory(sessionId: string, scope: WorkingMemoryRecord['scope'], key: string): Promise<WorkingMemoryRecord | null>;
  listWorkingMemory(sessionId: string): Promise<readonly WorkingMemoryRecord[]>;
  deleteWorkingMemory(sessionId: string, scope: WorkingMemoryRecord['scope'], key: string): Promise<void>;

  // ── Lorebook Entries (S3-T2) ──
  /**
   * Upsert a batch of session-scoped lorebook entries. Same `(sessionId, id)`
   * replaces the existing row. Used by the `lorebook.upsert` proposal commit
   * handler and by plugins that emit world data through the lorebook
   * pipeline (S3-T2 §A3).
   */
  upsertLorebookEntries(records: readonly LorebookEntryRecord[]): Promise<void>;
  /**
   * List all session-scoped lorebook entries for the given session, sorted
   * by `insertionOrder` ascending then `id` ascending for deterministic
   * output. Used by snapshot payload builder (FU-4) and by the context
   * loader to populate `{{ config.worldEntries }}` for backward compatibility.
   */
  listSessionLorebookEntries(sessionId: string): Promise<readonly LorebookEntryRecord[]>;
  /** Delete one session-scoped lorebook entry by `(sessionId, id)`. */
  deleteLorebookEntry(sessionId: string, id: string): Promise<void>;

  // ── Session Summaries (S2-T2 Compactor) ──
  saveSessionSummary(record: SessionSummaryRecord): Promise<void>;
  listSessionSummaries(sessionId: string): Promise<readonly SessionSummaryRecord[]>;
  deleteSessionSummaries(sessionId: string): Promise<void>;

  /**
   * Tag a set of turn messages as compacted into the given summary.
   * Sets `compactedAtTurnId = summaryId` on each message identified by
   * `messageIds`. Original content is preserved; only the prompt-build path
   * uses the summary in place of the compacted span.
   */
  tagTurnMessagesCompacted(sessionId: string, messageIds: readonly string[], summaryId: string): Promise<void>;

  // ── Suspensions (S4-T4) ──
  saveSuspension(record: SuspensionRecord): Promise<void>;
  getSuspension(id: string): Promise<SuspensionRecord | null>;
  markSuspensionResolved(id: string): Promise<void>;
  listSuspensions(sessionId: string): Promise<readonly SuspensionRecord[]>;
  deleteSuspension(id: string): Promise<void>;
  /**
   * Atomically claim an unresolved suspension.
   *
   * Returns `true` iff the suspension existed, was previously unresolved, and
   * is now marked as in-progress (`resolvedAt` set to a sentinel such as
   * `"claimed:<iso>"`). Returns `false` if the suspension does not exist or
   * was already claimed/resolved.
   *
   * Used by the resume route to guarantee exactly-once execution of a
   * suspended runtime even under concurrent POST /api/sessions/:id/resume
   * (audit 2026-04-20 finding 2). Callers should treat a `false` return as
   * "409 Conflict" and abandon the request.
   *
   * On successful completion of the resume pipeline, the caller overwrites
   * the claim sentinel via `markSuspensionResolved(id)`. On failure, the
   * caller should release the claim (re-issue `saveSuspension` with
   * `resolvedAt` unset) — see resume route for the policy.
   */
  claimSuspension(id: string): Promise<boolean>;

  // ── Snapshots (S4-T2) ──
  /**
   * Persist a materialized state snapshot. Used by auto / manual / fork flows.
   * Upsert semantics: re-saving the same id replaces the payload.
   */
  saveSnapshot(record: SnapshotRecord): Promise<void>;
  getSnapshot(id: string): Promise<SnapshotRecord | null>;
  /** List snapshots for a session, ordered by `createdAt` asc. */
  listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]>;
  deleteSnapshot(id: string): Promise<void>;

  // ── Transactions (S4-T1) ──
  /**
   * Begin a transaction. Subsequent writes are buffered until commit or rollback.
   *
   * On SQL backends this maps to `BEGIN`. On MemoryStore/IdbStore it takes a
   * structural snapshot of the current state that can be restored on rollback.
   *
   * Nested transactions are NOT supported. Calling `beginTx()` twice without an
   * intervening `commitTx()` / `rollbackTx()` throws.
   */
  beginTx(): Promise<void>;

  /**
   * Commit the current transaction. Buffered writes become durable.
   * Throws if no transaction is active.
   */
  commitTx(): Promise<void>;

  /**
   * Roll back the current transaction. Buffered writes are discarded.
   * Throws if no transaction is active.
   */
  rollbackTx(): Promise<void>;

  // ── Lifecycle ──
  close(): Promise<void>;
}

// ── Turn Messages (append-only conversation history) ─────────────

export interface TurnMessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sourceType: string;     // 'system' | 'runtime' | 'player' | 'tool' | 'player-input'
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string;           // 'system' | 'user' | 'assistant'
  readonly name?: string;
  readonly content: string;
  readonly ui?: unknown;           // JSON — UIRenderInstruction[]
  readonly pendingInput?: unknown;  // JSON — PlayerInputForm
  readonly order: number;
  readonly createdAt: string;
  /**
   * When set, this message has been compacted into a session summary.
   * The value is the `SessionSummaryRecord.id` that replaced this message.
   * The original content is preserved; only the prompt-build path substitutes
   * the summary in place of the compacted message span (S2-T2 Compactor).
   */
  readonly compactedAtTurnId?: string;  // summaryId, not a turn ID despite the name
}

// ── Session Summaries (S2-T2 Compactor) ─────────────────────────

export interface SessionSummaryRecord {
  readonly id: string;
  readonly sessionId: string;
  /** First compacted turnId (inclusive). */
  readonly turnRangeStart: string;
  /** Last compacted turnId (inclusive). */
  readonly turnRangeEnd: string;
  /** The summary text produced by the fast-slot LLM. */
  readonly content: string;
  /** Deduped list from plugin summaryFocus fields. */
  readonly focusSections: readonly string[];
  readonly createdAt: string;
}

export interface PlayerInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly formId: string;
  readonly values: unknown;        // JSON — Record<string, unknown>
  readonly createdAt: string;
}

// ── Snapshots (S4-T2) ────────────────────────────────────────────

/**
 * Materialized state snapshot (S4-T2, §A6).
 *
 * Each record captures the full session state at the end of a given turn as a
 * serialized payload. Snapshots power save / load / fork — every new session
 * created via `POST /fork` is rebuilt from a snapshot payload.
 *
 * `kind`:
 *  - `auto`   — created at turn commit when `COVEL_SNAPSHOTS_V1=1`.
 *  - `manual` — created explicitly via `POST /api/sessions/:id/snapshot`.
 *  - `fork`   — created when a fork rebuilds a new session; `parentId`
 *               points at the origin snapshot.
 *
 * `payload.schemaVersion` allows future migrations without requiring a DB
 * schema change — the envelope stays stable while the payload can evolve.
 */
export type SnapshotKind = 'auto' | 'manual' | 'fork';

export interface SnapshotPayload {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly characters: readonly CharacterRecord[];
  readonly stateEntries: readonly StateEntryRecord[];
  readonly pluginData: readonly PluginDataRecord[];
  readonly workingMemory: readonly WorkingMemoryRecord[];
  /**
   * Session-scoped lorebook entries (S3-T2). Captured from the
   * `lorebook_entries` table at snapshot time so forks can rehydrate the
   * session-layer lorebook without re-running world-init plugins.
   */
  readonly lorebookEntries: readonly LorebookEntryRecord[];
  /**
   * Unresolved suspensions at snapshot time (audit 2026-04-20 finding 7.3).
   *
   * Only suspensions whose `resolvedAt` is unset are captured — resolved or
   * claimed-but-still-executing records are excluded because the target
   * runtime is either done or in-flight and the child session has no way to
   * take over mid-flight. Each suspension travels with its full
   * `pendingContinuation` so the forked session can POST /resume using the
   * copied id.
   *
   * The fork route regenerates each suspension's id and rebinds
   * `sessionId = childSessionId` before persisting, so the original parent
   * record is preserved.
   */
  readonly suspensions: readonly SuspensionRecord[];
  /**
   * Last `turn_messages.id` persisted for this session at snapshot time.
   * Used by fork to bound how many messages are copied.
   * Empty string when there are no messages yet.
   */
  readonly messagesCursor: string;
}

export interface SnapshotRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: SnapshotKind;
  readonly parentId?: string;
  readonly payload: SnapshotPayload;
  readonly createdAt: string;
}

// ── Suspensions (S4-T4) ──────────────────────────────────────────

/**
 * Persisted state for a suspended runtime (S4-T4 suspend/resume primitive).
 *
 * When an agent runtime calls the `suspend` builtin tool, the turn-executor
 * captures the current LLM message array and tool-call history, writes a
 * SuspensionRecord, and returns `status: 'suspended'`.
 *
 * On `POST /api/sessions/:id/resume { suspensionId, data }`, the resume
 * handler loads this record, reconstructs the message array, appends a
 * synthetic message carrying `data`, and re-enters the LLM tool loop.
 *
 * NOTE: Provider API keys are NEVER stored here — they must be supplied
 * again via the `X-Provider-Keys` header on the resume request.
 */
export interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly reason: string;
  /** Plain JSON schema object { type, properties, required }. Not a live Zod schema. */
  readonly resumeSchema: unknown;
  readonly pendingContinuation: {
    /** Full LLMMessage[] up to the suspend point. */
    readonly messages: readonly unknown[];
    /** If the LLM produced narrative text alongside the suspend tool call. */
    readonly partialContent?: string;
    /** ToolCallRecord[] accumulated before the suspend point. */
    readonly toolCallsSoFar: readonly unknown[];
    /**
     * Proposals buffered mid-turn at the suspend point.
     *
     * Agent tools can queue proposal-backed writes before the runtime
     * decides to suspend. Resume re-hydrates this array so the buffered
     * proposals survive the suspend boundary and commit together with the
     * final runtime output.
     */
    readonly pendingProposals: readonly unknown[];
    /** tool_call_id of the suspend tool call (agent runtime only). Used to append synthetic tool result. */
    readonly suspendToolCallId?: string;
  };
  readonly createdAt: string;
  /** Set to ISO timestamp when resume completes successfully. */
  readonly resolvedAt?: string;
}

// ── Store config ─────────────────────────────────────────────────

export type StoreBackend = 'memory' | 'sqlite' | 'pg';

export interface StoreConfig {
  readonly backend: StoreBackend;
  /** SQLite file path (default: ./data/covel.db) */
  readonly sqlitePath?: string;
  /** PostgreSQL connection URL */
  readonly databaseUrl?: string;
}
