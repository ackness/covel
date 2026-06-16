/**
 * Unified DataStore interface and record types.
 *
 * All data is session-scoped. Server deployments switch backends through
 * STORE_BACKEND (memory | sqlite | pg). Browser callers can request idb
 * directly through createStore({ backend: "idb" }).
 *
 * Record type definitions are organised by domain under `./records/*`; this
 * module re-exports them all so existing `../types.js` imports keep working,
 * and additionally declares the `DataStore` interface and store config types.
 */

// ── Record type re-exports (by domain) ───────────────────────────

export type { WorldRecord } from "./records/world-records.js";
export { normalizeWorldRecord } from "./records/world-records.js";

export type { SessionRecord } from "./records/session-records.js";
export {
  normalizeSessionRecord,
  mergeSessionPatch,
} from "./records/session-records.js";

export type {
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
} from "./records/runtime-records.js";

export type {
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
} from "./records/state-records.js";

export type {
  PluginDataRecord,
  PluginConfigRecord,
  TraceEventRecord,
} from "./records/plugin-records.js";

export type {
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  TurnMessageRecord,
  SessionSummaryRecord,
  PlayerInputRecord,
} from "./records/memory-records.js";

export type {
  SnapshotKind,
  SnapshotPayload,
  SnapshotRecord,
  SuspensionRecord,
} from "./records/snapshot-records.js";

export type { PaginationOpts } from "./records/pagination-records.js";

// ── Local imports for the DataStore interface signatures ─────────

import type { WorldRecord } from "./records/world-records.js";
import type { SessionRecord } from "./records/session-records.js";
import type {
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  RuntimeOutputRecord,
  InteractionRecordRow,
  RuntimeOutputFilters,
  InteractionRecordFilters,
} from "./records/runtime-records.js";
import type {
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
} from "./records/state-records.js";
import type {
  PluginDataRecord,
  PluginConfigRecord,
  TraceEventRecord,
} from "./records/plugin-records.js";
import type {
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  TurnMessageRecord,
  SessionSummaryRecord,
  PlayerInputRecord,
} from "./records/memory-records.js";
import type {
  SnapshotRecord,
  SuspensionRecord,
} from "./records/snapshot-records.js";
import type { PaginationOpts } from "./records/pagination-records.js";

// ── DataStore interface ──────────────────────────────────────────

export interface DataStore {
  // ── Session ──
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(
    id: string,
    patch: Partial<
      Pick<
        SessionRecord,
        | "status"
        | "turnCount"
        | "preGameCompleted"
        | "activePlugins"
        | "presetId"
        | "updatedAt"
        | "metadata"
        | "embeddingModelId"
        | "embeddingLockedAt"
        | "runtimeModelOverrides"
      >
    >,
  ): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;

  // ── Turn Results ──
  saveTurnResult(record: TurnResultRecord): Promise<void>;
  getTurnResult(
    sessionId: string,
    turnId: string,
  ): Promise<TurnResultRecord | null>;
  listTurnResults(
    sessionId: string,
    limit?: number,
  ): Promise<TurnResultRecord[]>;

  // ── Runtime Results ──
  saveRuntimeResult(record: RuntimeResultRecord): Promise<void>;
  listRuntimeResults(
    sessionId: string,
    turnId: string,
  ): Promise<RuntimeResultRecord[]>;

  // ── Tool Calls ──
  saveToolCall(record: ToolCallRecordRow): Promise<void>;
  listToolCalls(
    sessionId: string,
    turnId?: string,
  ): Promise<ToolCallRecordRow[]>;

  // ── Runtime Outputs (PR-1 translation layer) ──
  saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void>;
  getRuntimeOutput(
    sessionId: string,
    id: string,
  ): Promise<RuntimeOutputRecord | null>;
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
  getStateEntry(
    sessionId: string,
    tableName: string,
    fieldName: string,
  ): Promise<StateEntryRecord | null>;
  upsertStateEntry(record: StateEntryRecord): Promise<void>;
  listStateEntries(
    sessionId: string,
    tableName: string,
  ): Promise<StateEntryRecord[]>;

  // ── State Changes ──
  addStateChange(record: StateChangeRecord): Promise<void>;
  listStateChanges(
    sessionId: string,
    tableName: string,
    fieldName: string,
  ): Promise<StateChangeRecord[]>;

  // ── Events ──
  saveEvent(record: EventRecord): Promise<void>;
  listEvents(
    sessionId: string,
    options?: { topic?: string; limit?: number },
  ): Promise<EventRecord[]>;

  // ── Approvals ──
  saveApproval(record: ApprovalRecord): Promise<void>;
  listApprovals(sessionId: string): Promise<ApprovalRecord[]>;

  // ── Messages ──
  addMessage(record: MessageRecord): Promise<void>;
  listMessages(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<MessageRecord[]>;

  // ── Characters ──
  upsertCharacter(record: CharacterRecord): Promise<void>;
  listCharacters(sessionId: string): Promise<CharacterRecord[]>;
  deleteCharacter(sessionId: string, id: string): Promise<void>;

  // ── Plugin Data ──
  setPluginData(record: PluginDataRecord): Promise<void>;
  setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void>;
  getPluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<PluginDataRecord | null>;
  listPluginData(
    sessionId: string,
    pluginId: string,
    namespace?: string,
    pagination?: PaginationOpts,
  ): Promise<PluginDataRecord[]>;
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
  listPluginDataSessionScope(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<readonly PluginDataRecord[]>;
  deletePluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<void>;

  // ── Plugin Configs ──
  savePluginConfig(record: PluginConfigRecord): Promise<void>;
  getPluginConfig(
    sessionId: string,
    pluginId: string,
  ): Promise<PluginConfigRecord | null>;

  // ── Worlds ──
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  upsertWorld(record: WorldRecord): Promise<void>;
  deleteWorld(id: string): Promise<void>;

  // ── Trace ──
  addTraceEvent(record: TraceEventRecord): Promise<void>;
  listTraceEvents(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<TraceEventRecord[]>;

  // ── Turn Messages (append-only) ──
  appendTurnMessage(record: TurnMessageRecord): Promise<void>;
  listTurnMessages(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<TurnMessageRecord[]>;

  // ── Player Inputs ──
  savePlayerInput(record: PlayerInputRecord): Promise<void>;
  getPlayerInput(
    sessionId: string,
    formId: string,
  ): Promise<PlayerInputRecord | null>;
  listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]>;

  // ── Working Memory (S3-T3) ──
  upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void>;
  getWorkingMemory(
    sessionId: string,
    scope: WorkingMemoryRecord["scope"],
    key: string,
  ): Promise<WorkingMemoryRecord | null>;
  listWorkingMemory(sessionId: string): Promise<readonly WorkingMemoryRecord[]>;
  deleteWorkingMemory(
    sessionId: string,
    scope: WorkingMemoryRecord["scope"],
    key: string,
  ): Promise<void>;

  // ── World Data Import Ledger ──
  saveWorldDataImportLedgerBatch(
    records: readonly WorldDataImportLedgerRecord[],
  ): Promise<void>;
  listWorldDataImportLedger(
    sessionId: string,
  ): Promise<readonly WorldDataImportLedgerRecord[]>;
  deleteWorldDataImportLedger(sessionId: string, id: string): Promise<void>;

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
  listSessionLorebookEntries(
    sessionId: string,
  ): Promise<readonly LorebookEntryRecord[]>;
  /** Delete one session-scoped lorebook entry by `(sessionId, id)`. */
  deleteLorebookEntry(sessionId: string, id: string): Promise<void>;

  // ── Session Summaries (S2-T2 Compactor) ──
  saveSessionSummary(record: SessionSummaryRecord): Promise<void>;
  listSessionSummaries(
    sessionId: string,
  ): Promise<readonly SessionSummaryRecord[]>;
  deleteSessionSummaries(sessionId: string): Promise<void>;

  /**
   * Tag a set of turn messages as compacted into the given summary.
   * Sets `compactedAtTurnId = summaryId` on each message identified by
   * `messageIds`. Original content is preserved; only the prompt-build path
   * uses the summary in place of the compacted span.
   */
  tagTurnMessagesCompacted(
    sessionId: string,
    messageIds: readonly string[],
    summaryId: string,
  ): Promise<void>;

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

// ── Store config ─────────────────────────────────────────────────

export type StoreBackend = "memory" | "sqlite" | "pg" | "idb";
export type RuntimeStoreBackend = Exclude<StoreBackend, "idb">;

export interface StoreConfig {
  readonly backend: StoreBackend;
  /** SQLite file path (default: ./data/covel.db) */
  readonly sqlitePath?: string;
  /** PostgreSQL connection URL */
  readonly databaseUrl?: string;
  /** IndexedDB database name (default: covel-browser) */
  readonly idbDbName?: string;
}
