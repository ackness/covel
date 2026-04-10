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
}

export interface PlayerInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly formId: string;
  readonly values: unknown;        // JSON — Record<string, unknown>
  readonly createdAt: string;
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
