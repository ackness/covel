/**
 * Unified DataStore interface and record types.
 *
 * All data is session-scoped. Switching backends requires only changing
 * the STORE_BACKEND environment variable (memory | sqlite | pg).
 */

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
  readonly phase: string;
  readonly turnCount: number;
  readonly locale: string;
  readonly activePlugins: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
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

export interface TraceEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly traceId: string;
  readonly turnId: string;
  readonly payload: unknown;       // JSON
  readonly createdAt: string;
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
  updateSession(id: string, patch: Partial<Pick<SessionRecord, 'phase' | 'turnCount' | 'activePlugins' | 'updatedAt'>>): Promise<void>;
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
  deletePluginData(sessionId: string, pluginId: string, namespace: string, key: string): Promise<void>;

  // ── Plugin Configs ──
  savePluginConfig(record: PluginConfigRecord): Promise<void>;
  getPluginConfig(sessionId: string, pluginId: string): Promise<PluginConfigRecord | null>;

  // ── Worlds ──
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  upsertWorld(record: WorldRecord): Promise<void>;

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
  /** Session-scoped lorebook entries. See note in snapshot-payload-builder. */
  readonly lorebookEntries: readonly unknown[];
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
     * TODO(S4-T4.b): pendingProposals are not yet populated — the suspend
     * point is currently always before any proposal-generating runtime output,
     * so this is safe for now. When mid-turn proposal collection lands, capture
     * accumulated proposals here so they are committed on resume completion.
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
