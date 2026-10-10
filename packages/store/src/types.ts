/**
 * Unified DataStore interface and record types.
 *
 * All data is session-scoped. Server deployments switch backends through
 * STORE_BACKEND (memory | sqlite | pg). Browser-private persistence uses the
 * dedicated Dexie BrowserVault contract rather than implementing DataStore.
 *
 * Record type definitions are organised by domain under `./records/*`; this
 * module re-exports them all so existing `../types.js` imports keep working,
 * and additionally declares the `DataStore` interface and store config types.
 */

// ── Record type re-exports (by domain) ───────────────────────────

export type { CharacterSchemaRecord, LorebookOwner } from "@covel/shared";
import type { CharacterSchemaRecord, LorebookOwner } from "@covel/shared";

export type { WorldRecord } from "./records/world-records.js";
export { normalizeWorldRecord } from "./records/world-records.js";

export type { ServerSettingRecord } from "./records/server-setting-records.js";

export type { SessionRecord } from "./records/session-records.js";
export { mergeSessionPatch } from "./records/session-records.js";

export type {
  FailedRuntimeResult,
  TurnResultRecord,
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
  MessageRecord,
  CharacterRecord,
} from "./records/state-records.js";

export type {
  PluginDataRecord,
  TraceEventRecord,
} from "./records/plugin-records.js";

export type {
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  TurnMessageRecord,
  SessionSummaryRecord,
  PlayerInputRecord,
} from "./records/memory-records.js";

export type {
  SnapshotKind,
  SnapshotPayload,
  SnapshotSessionState,
  SnapshotRecord,
  SnapshotMetadata,
  SuspensionRecord,
} from "./records/snapshot-records.js";

// Session-lifecycle records live in @covel/shared (the cross-layer contract);
// re-exported here so store consumers import them alongside the store records.
export type {
  SetupRuntimeState,
  SetupAttemptState,
  SetupAttemptRecord,
  LogicalTurnLedgerRecord,
  JobStatusState,
  JobStatusRecord,
  RuntimeExportRecord,
} from "@covel/shared";

export type {
  PaginationOpts,
  TimeCursor,
  CursorPageOpts,
} from "./records/pagination-records.js";

// ── Local imports for the DataStore interface signatures ─────────

import type { WorldRecord } from "./records/world-records.js";
import type { ServerSettingRecord } from "./records/server-setting-records.js";
import type { SessionRecord } from "./records/session-records.js";
import type {
  FailedRuntimeResult,
  TurnResultRecord,
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
  MessageRecord,
  CharacterRecord,
} from "./records/state-records.js";
import type {
  PluginDataRecord,
  TraceEventRecord,
} from "./records/plugin-records.js";
import type {
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  TurnMessageRecord,
  SessionSummaryRecord,
  PlayerInputRecord,
} from "./records/memory-records.js";
import type {
  SnapshotRecord,
  SnapshotMetadata,
  SuspensionRecord,
} from "./records/snapshot-records.js";
import type {
  PaginationOpts,
  CursorPageOpts,
} from "./records/pagination-records.js";
import type {
  SetupAttemptRecord,
  SetupAttemptState,
  LogicalTurnLedgerRecord,
  JobStatusRecord,
  RuntimeExportRecord,
} from "@covel/shared";

// ── Domain sub-interfaces ────────────────────────────────────────
//
// `DataStore` is composed from the focused domain interfaces below rather than
// declared as one flat god-interface (audit H3 / A1). Each sub-interface owns a
// single persistence domain and is named to align with the backend record
// modules (`postgres/pg-*-records.ts`, `common/sql-*-records.ts`) and the
// `contract/suites/*` groups. The backends already compose method groups this
// way — e.g. `buildPgData()` in `postgres/pg-store.ts` spreads
// `createPgSessionRecords` / `createPgStateRecords` / `createPgSnapshotRecords`
// / … — so these interfaces simply give that decomposition a name at the type
// layer. `DataStore` re-composes them all (see below) into a shape that is
// byte-for-byte identical to the previous flat interface, so every downstream
// `import { DataStore }` is unaffected.

/** Session lifecycle CRUD (`pg/sqlite session-records`). */
export interface SessionStore {
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(
    id: string,
    patch: Partial<
      Pick<
        SessionRecord,
        | "status"
        | "activePlugins"
        | "locale"
        | "updatedAt"
        | "metadata"
        | "embeddingModelId"
        | "embeddingLockedAt"
        | "runtimeModelOverrides"
        | "phase"
        | "completedPlayerTurns"
        | "setupRuntimes"
      >
    >,
  ): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;
}

/**
 * Turn / runtime execution records — turn results, runtime results, tool
 * calls, runtime outputs, and interaction records. Aligns with the single
 * `runtime-records` module (`common/sql-runtime-records.ts`) and the
 * `runtime-record-suites` contract group.
 */
export interface RuntimeRecordStore {
  // ── Turn Results ──
  saveTurnResult(record: TurnResultRecord): Promise<void>;
  /** Filter before decoding result payloads; recursive artifacts are excluded. */
  queryTurnResults(
    sessionId: string,
    options: {
      turnId?: string;
      since?: string;
      origins?: readonly TurnResultRecord["origin"][];
      commitStatus?: TurnResultRecord["commitStatus"];
      newestFirst?: boolean;
      limit?: number;
    },
  ): Promise<TurnResultRecord[]>;
  listTurnResults(
    sessionId: string,
    limit?: number,
  ): Promise<TurnResultRecord[]>;
  /**
   * Settle a persisted execution artifact's commit outcome.
   *
   * `saveTurnResult` writes the row BEFORE proposals commit, so it starts
   * `pending`. The commit-owning caller marks it `committed` or `failed`;
   * a row still `pending` afterwards is a crash signature, which is otherwise
   * indistinguishable from a successful turn. No-op when the turn has no row.
   *
   * `failedRuntimes` settles those entries of `runtimeResults` as `failed`
   * with their `error`: a committed execution may still drop an optional
   * runtime's writes, and its recorded result must not read as success.
   */
  setTurnResultCommitStatus(
    sessionId: string,
    turnId: string,
    status: TurnResultRecord["commitStatus"],
    failedRuntimes?: readonly FailedRuntimeResult[],
  ): Promise<void>;

  // ── Tool Calls ──
  saveToolCall(record: ToolCallRecordRow): Promise<void>;
  listToolCalls(
    sessionId: string,
    turnId?: string,
  ): Promise<ToolCallRecordRow[]>;

  // ── Runtime Outputs (translation layer) ──
  saveRuntimeOutput(record: RuntimeOutputRecord): Promise<void>;
  getRuntimeOutput(
    sessionId: string,
    id: string,
  ): Promise<RuntimeOutputRecord | null>;
  listRuntimeOutputs(
    sessionId: string,
    filters?: RuntimeOutputFilters,
  ): Promise<RuntimeOutputRecord[]>;

  // ── Interaction Records (translation layer) ──
  saveInteractionRecord(record: InteractionRecordRow): Promise<void>;
  listInteractionRecords(
    sessionId: string,
    filters?: InteractionRecordFilters,
  ): Promise<InteractionRecordRow[]>;
}

/** State schemas / entries / changes (`common/sql-state-records.ts`). */
export interface StateStore {
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
}

/** Session-scoped event log. Part of `sql-session-content-records`. */
export interface EventStore {
  saveEvent(record: EventRecord): Promise<void>;
  listEvents(
    sessionId: string,
    options?: { topic?: string; limit?: number },
  ): Promise<EventRecord[]>;
  /**
   * Targeted by-id read (event ids are globally unique). `sessionId` is a
   * scope guard: an id belonging to another session returns null. Used by the
   * EventBus transport to re-fetch oversize cross-pod events without a full
   * `listEvents` scan.
   */
  getEventById(sessionId: string, id: string): Promise<EventRecord | null>;
  deleteEventsBefore(sessionId: string, before: string): Promise<void>;
}

/** Chat/narrative message log. Part of `sql-session-content-records`. */
export interface MessageStore {
  addMessage(record: MessageRecord): Promise<void>;
  /**
   * Insert a finalized user input, or adopt its same-session, same-content
   * uncommitted browser row by id. Preserve its timestamp and reject occupied
   * or ids committed to a different turn; identical same-turn commits are
   * no-ops. Call within the turn finalization transaction.
   */
  commitPlayerInputMessage(record: MessageRecord): Promise<void>;
  listMessages(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<MessageRecord[]>;
  /**
   * Keyset page of messages, oldest-first. `before` omitted ⇒ the newest
   * `limit` messages (session-restore's initial window); `before` set ⇒ the
   * `limit` messages immediately older than that `(createdAt, id)` position
   * (scroll-up "load older"). A single descending, limited query — a long
   * session never loads its whole history. Keeps `listMessages`'s ascending
   * offset semantics untouched (the media GC scan depends on them).
   */
  listMessagesPage(
    sessionId: string,
    opts: CursorPageOpts,
  ): Promise<MessageRecord[]>;
}

/** Character records. Part of `sql-session-content-records`. */
export interface CharacterStore {
  getCharacterSchema(sessionId: string): Promise<CharacterSchemaRecord | null>;
  upsertCharacterSchema(record: CharacterSchemaRecord): Promise<void>;
  /** Replace the complete snapshot, including timestamps. Null fields clear attributes. */
  upsertCharacter(record: CharacterRecord): Promise<void>;
  listCharacters(sessionId: string): Promise<CharacterRecord[]>;
  deleteCharacter(sessionId: string, id: string): Promise<void>;
}

export interface PluginDataBatchCasEntry {
  readonly namespace: string;
  readonly key: string;
  /** Null creates only if absent; otherwise match the JSON envelope's version. */
  readonly expectedVersion: number | null;
  readonly value: unknown;
  readonly timestamp: string;
}

/** Session-scoped plugin KV data (`common/sql-data-crud.ts`). */
export interface PluginDataStore {
  /** Bounded prompt projection: oldest half, then most recently updated rows. */
  getPluginDataPromptWindow(
    sessionId: string,
    pluginId: string,
    namespace: string,
    maxEntries: number,
  ): Promise<{ entries: PluginDataRecord[]; total: number }>;
  /** Indexed namespace query, optionally filtered by a top-level JSON string field. */
  queryPluginData(options: {
    namespace: string;
    sessionId?: string;
    pluginId?: string;
    valueFilter?: { field: string; values: readonly string[] };
  }): Promise<PluginDataRecord[]>;
  /** All comparisons succeed and all rows commit, or no rows change. */
  compareAndSetPluginDataBatch(
    sessionId: string,
    pluginId: string,
    records: readonly PluginDataBatchCasEntry[],
  ): Promise<boolean>;
  setPluginData(record: PluginDataRecord): Promise<void>;
  setPluginDataBatch(records: readonly PluginDataRecord[]): Promise<void>;
  /**
   * Atomically create or replace one plugin-data row when its current revision
   * matches `expectedUpdatedAt`.
   *
   * Passing `null` is insert-if-absent. Passing a timestamp updates only when
   * the existing row has that exact `updatedAt`; a missing or changed row
   * returns `false`. This is the portable CAS primitive used by durable
   * framework control planes (runtime jobs, leases) without weakening the
   * plugin-data JSON contract.
   */
  compareAndSetPluginData(
    record: PluginDataRecord,
    expectedUpdatedAt: string | null,
  ): Promise<boolean>;
  getPluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<PluginDataRecord | null>;
  /**
   * One plugin's rows in `(createdAt, pluginId, namespace, key)` order, the
   * order of every plugin-data list. A rewrite keeps a row's `id` and
   * `createdAt`, so the order of a session's rows is the same from turn to
   * turn, in a fork, and in another run of the same scripted session.
   */
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
  /**
   * List one namespace's rows for a session across every pluginId, in the
   * order of every plugin-data list: `(createdAt, pluginId, namespace, key)`. Framework control planes (runtime jobs) keep one
   * namespace per plugin and need the session-wide view without loading every
   * other plugin's data.
   */
  listPluginDataByNamespace(
    sessionId: string,
    namespace: string,
  ): Promise<readonly PluginDataRecord[]>;
  deletePluginData(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<void>;
}

/** World package registry (`common/sql-world-records.ts`). */
export interface WorldStore {
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  /** Atomically insert a world, returning false when its id already exists. */
  createWorld(record: WorldRecord): Promise<boolean>;
  upsertWorld(record: WorldRecord): Promise<void>;
  deleteWorld(id: string): Promise<void>;
}

/** Trace event journal. Part of `sql-session-journal-records`. */
/**
 * Server-scoped settings (`common/sql-server-setting-records.ts`): values the
 * server acts on, shared by every process that uses the database. A key that
 * is not set has no row.
 */
export interface ServerSettingStore {
  /** Every stored setting, in key order. */
  listServerSettings(): Promise<ServerSettingRecord[]>;
  /** Insert the setting or replace its value. */
  setServerSetting(record: ServerSettingRecord): Promise<void>;
  deleteServerSetting(key: string): Promise<void>;
}

export interface TraceStore {
  addTraceEvent(record: TraceEventRecord): Promise<void>;
  getTraceEventById(
    sessionId: string,
    id: string,
  ): Promise<TraceEventRecord | null>;
  queryTraceEvents(
    sessionId: string,
    options: {
      turnId?: string;
      types?: readonly string[];
      excludeTypes?: readonly string[];
      newestFirst?: boolean;
      limit?: number;
    },
  ): Promise<TraceEventRecord[]>;
  listTraceEvents(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<TraceEventRecord[]>;
  /**
   * Keyset page of trace events, oldest-first. `before` omitted ⇒ the newest
   * `limit` events; `before` set ⇒ the `limit` events immediately older than
   * that `(createdAt, id)` position. The debug turn view groups the returned
   * events by `turnId` and reconciles the boundary turn across pages, so this
   * stays an event-level cursor. `trace_events` is the fastest-growing table —
   * this bounds the read; `listTraceEvents`'s full scan is left for the media
   * GC scan that needs every row.
   */
  listTraceEventsPage(
    sessionId: string,
    opts: CursorPageOpts,
  ): Promise<TraceEventRecord[]>;
  /** Delete a session's trace events created strictly before `before` (ISO). */
  deleteTraceEventsBefore(sessionId: string, before: string): Promise<void>;
}

/**
 * Whole-session turn-message aggregates, computed store-side so the per-turn
 * pipeline never has to load the full message history just to count it.
 */
export interface TurnMessageStats {
  /** Total messages with `sourceType === "player"` (the turn number). */
  readonly playerMessageCount: number;
}

/** One compacted turn message and the session summary that replaced it. */
export interface CompactedTurnMessageTag {
  readonly id: string;
  readonly summaryId: string;
}

/** Append-only turn-message log. Part of `sql-session-journal-records`. */
export interface TurnMessageStore {
  appendTurnMessage(record: TurnMessageRecord): Promise<void>;
  listTurnMessages(
    sessionId: string,
    pagination?: PaginationOpts,
  ): Promise<TurnMessageRecord[]>;
  /**
   * List only messages NOT yet folded into a compaction summary
   * (`compactedAtTurnId` unset), oldest-first. Because the compactor always
   * tags a contiguous prefix of the timeline, this is exactly the raw suffix
   * the prompt builder and the compactor itself operate on — the compacted
   * prefix is represented by `listSessionSummaries` instead. With compaction
   * enabled this read stays bounded for the life of a session, unlike
   * {@link listTurnMessages}.
   */
  listUncompactedTurnMessages(
    sessionId: string,
    limit?: number,
  ): Promise<TurnMessageRecord[]>;
  /**
   * Forward keyset read: the first `limit` messages strictly after the
   * `(createdAt, id)` cursor position, oldest-first (all messages from the
   * start when `after` is null). Lets incremental consumers (vector-ingest's
   * recall cursor) walk the log without loading it whole. `limit <= 0` ⇒ `[]`.
   */
  listTurnMessagesAfter(
    sessionId: string,
    after: { readonly createdAt: string; readonly id: string } | null,
    limit: number,
  ): Promise<TurnMessageRecord[]>;
  /**
   * Aggregate counts over the FULL message log (compacted rows included),
   * resolved as a grouped count query on SQL backends. Replaces the per-turn
   * "load every row and count in JS" scan.
   */
  getTurnMessageStats(sessionId: string): Promise<TurnMessageStats>;
  /**
   * Return the **most recent** `limit` turn messages, ordered oldest-first
   * (the tail of {@link listTurnMessages}).
   *
   * This differs from `listTurnMessages(sessionId, { limit })`, which returns
   * the OLDEST `limit` rows (ascending order + front-truncated). Backends
   * resolve this with a single descending-ordered, limited query, so a long
   * session never loads its whole history into memory just to keep the tail
   * (recall search, plugin "recent context" reads). A `limit <= 0` returns an
   * empty array.
   */
  listRecentTurnMessages(
    sessionId: string,
    limit: number,
  ): Promise<TurnMessageRecord[]>;
  /**
   * The compacted messages of a session and the summary each was folded into,
   * oldest-first, without their content. A snapshot records this mapping; it
   * does not need the text of the whole log to build it.
   */
  listCompactedTurnMessageTags(
    sessionId: string,
  ): Promise<CompactedTurnMessageTag[]>;
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
  /**
   * Repoint selected already-compacted messages to a replacement summary.
   * Omitting sourceSummaryIds selects all compacted messages in the session. Used when the compactor merges prior summaries so no
   * message retains an orphaned summary id.
   */
  retagCompactedTurnMessages(
    sessionId: string,
    summaryId: string,
    sourceSummaryIds?: readonly string[],
  ): Promise<void>;
}

/** Player form-input records. Part of `sql-session-journal-records`. */
export interface PlayerInputStore {
  /** Newest form submission ordered by createdAt, then byte-ordered ID. */
  getLatestPlayerInput(sessionId: string): Promise<PlayerInputRecord | null>;
  savePlayerInput(record: PlayerInputRecord): Promise<void>;
  listPlayerInputs(sessionId: string): Promise<PlayerInputRecord[]>;
}

/** World-data import ledger (`common/sql-data-crud.ts`). */
export interface WorldDataImportLedgerStore {
  saveWorldDataImportLedgerBatch(
    records: readonly WorldDataImportLedgerRecord[],
  ): Promise<void>;
  listWorldDataImportLedger(
    sessionId: string,
  ): Promise<readonly WorldDataImportLedgerRecord[]>;
  deleteWorldDataImportLedger(sessionId: string, id: string): Promise<void>;
}

/** Session-scoped lorebook entries (`common/sql-data-crud.ts`). */
export interface LorebookStore {
  /**
   * Upsert a batch of session-scoped lorebook entries. Same `(sessionId, owner, id)`
   * replaces the existing row. Used by the `lorebook.upsert` proposal commit
   * handler and by plugins that emit world data through the lorebook
   * pipeline.
   */
  upsertLorebookEntries(records: readonly LorebookEntryRecord[]): Promise<void>;
  /**
   * List all session-scoped lorebook entries for the given session, sorted
   * by `insertionOrder` ascending then `id` ascending for deterministic
   * output. Used by the snapshot payload builder (FU-4) and by the
   * session-context loader's world-entries injection.
   */
  listSessionLorebookEntries(
    sessionId: string,
  ): Promise<readonly LorebookEntryRecord[]>;
  getLorebookEntry(
    sessionId: string,
    owner: LorebookOwner,
    id: string,
  ): Promise<LorebookEntryRecord | null>;
  /** Delete the exact owner-scoped entry. */
  deleteLorebookEntry(
    sessionId: string,
    owner: LorebookOwner,
    id: string,
  ): Promise<void>;
}

/** Compactor summaries. Part of `sql-session-journal-records`. */
export interface SessionSummaryStore {
  saveSessionSummary(record: SessionSummaryRecord): Promise<void>;
  listSessionSummaries(
    sessionId: string,
  ): Promise<readonly SessionSummaryRecord[]>;
  deleteSessionSummaries(
    sessionId: string,
    summaryIds?: readonly string[],
  ): Promise<void>;
}

/** Runtime suspension records. Part of `sql-snapshot-records`. */
export interface SuspensionStore {
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
   * suspended runtime even under concurrent resume requests
   * (audit 2026-04-20 finding 2). Callers should treat a `false` return as
   * "409 Conflict" and abandon the request.
   *
   * On successful completion of the resume pipeline, the caller overwrites
   * the claim sentinel via `markSuspensionResolved(id)`. On failure, the
   * caller should release the claim (re-issue `saveSuspension` with
   * `resolvedAt` unset) — see resume route for the policy.
   */
  claimSuspension(id: string): Promise<boolean>;
  /**
   * Global maintenance sweep of stale suspensions.
   *
   * Deletes ONLY records that are still unresolved (`resolvedAt` unset) AND
   * whose `createdAt` is strictly older than `olderThanIso`. Claimed
   * (in-flight, `"claimed:<iso>"`) and successfully-resolved records are never
   * touched — an in-progress or completed resume must survive the sweep.
   *
   * Not session-scoped: a single call sweeps every session. `olderThanIso` is
   * an ISO-8601 UTC timestamp compared lexicographically (chronologically
   * correct for normalized ISO strings). Returns the number of records deleted.
   *
   * Best-effort: callers (startup + opportunistic route sweep) treat any error
   * as non-fatal. See `apps/server/src/routes/api/suspension-sweep.ts`.
   */
  deleteExpiredSuspensions(olderThanIso: string): Promise<number>;
  /**
   * Make suspensions claimable again when their claim (`"claimed:<iso>"`) is
   * strictly older than `olderThanIso`: the process that claimed them ended
   * before it released or resolved the claim. Resolved records and newer
   * claims are not touched. Not session-scoped. Returns the number released.
   */
  releaseStaleSuspensionClaims(olderThanIso: string): Promise<number>;
}

/**
 * Session-lifecycle records for the scheduling redesign (`sql-lifecycle-records`):
 * the logical-turn completion ledger, the setup-runtime attempt log, and the
 * append-only job-status stream. Every method is usable inside a
 * {@link TransactionalStore.withTransaction} handler.
 */
export interface LifecycleStore {
  /**
   * Record that a logical turn completed. Idempotent on
   * `(sessionId, logicalTurnId)`: returns `true` when this call inserted the
   * ledger row, `false` when the turn was already recorded (no overwrite, no
   * throw). This boolean is the "count this turn at most once" guarantee.
   */
  insertLogicalTurnCompletion(
    record: LogicalTurnLedgerRecord,
  ): Promise<boolean>;
  getLogicalTurnCompletion(
    sessionId: string,
    logicalTurnId: string,
  ): Promise<LogicalTurnLedgerRecord | null>;
  /** List every completed logical turn for checkpoint/export workflows. */
  listLogicalTurnCompletions(
    sessionId: string,
  ): Promise<readonly LogicalTurnLedgerRecord[]>;

  /**
   * Insert a setup-runtime attempt. Idempotent on
   * `(sessionId, runtimeId, generation, executionId)`: returns `true` when this
   * call inserted the row, `false` when the attempt already existed (no
   * overwrite, no throw).
   */
  insertSetupAttempt(record: SetupAttemptRecord): Promise<boolean>;
  /**
   * Terminalise an existing setup attempt (identified by its full unique key)
   * with a new `state` and optional `finishedAt` / `error`. No-op when the
   * attempt does not exist.
   */
  updateSetupAttempt(
    sessionId: string,
    runtimeId: string,
    generation: number,
    executionId: string,
    patch: {
      readonly state: SetupAttemptState;
      readonly finishedAt?: string;
      readonly error?: string;
    },
  ): Promise<void>;
  listSetupAttempts(
    sessionId: string,
    filter?: { readonly runtimeId?: string; readonly generation?: number },
  ): Promise<readonly SetupAttemptRecord[]>;

  /**
   * Append a job-status event. Append-only and idempotent on
   * `(sessionId, progressScopeId, pluginId, runtimeId, jobId, sequence)`:
   * returns `true` when this call inserted the event, `false` when a duplicate
   * `sequence` for the same job was already stored (the earlier event wins; no
   * overwrite, no throw).
   */
  appendJobStatus(record: JobStatusRecord): Promise<boolean>;
  /** List job-status events for a session, ordered by `(jobId, sequence)` asc. */
  listJobStatus(
    sessionId: string,
    filter?: { readonly progressScopeId?: string; readonly jobId?: string },
  ): Promise<readonly JobStatusRecord[]>;
  /** Delete every job-status event of the given jobs in a session. */
  deleteJobStatus(sessionId: string, jobIds: readonly string[]): Promise<void>;
}

/**
 * Runtime exports for the scheduling redesign (`sql-export-records`): the
 * session-scoped, read-only, cross-plugin, versioned publications produced by
 * `output.recordAs`. Every method is usable inside a
 * {@link TransactionalStore.withTransaction} handler (the intended publish site
 * is the finalizeExecution transaction).
 */
export interface ExportStore {
  /**
   * Publish a runtime export at its `revision`. Idempotent on
   * `(sessionId, producerRuntimeId, recordAs, revision)`: returns `true` when
   * this call inserted the row, `false` when that revision was already stored
   * (no overwrite, no throw). The boolean lets the caller detect a lost race for
   * a revision number.
   */
  appendRuntimeExport(record: RuntimeExportRecord): Promise<boolean>;
  /**
   * The latest committed export for `(sessionId, producerRuntimeId, recordAs)`,
   * i.e. the row with the highest `revision`, or `null` when none exists.
   *
   * `opts.atOrBefore` is the frozen-read cutoff: only revisions with
   * `committedAt <= atOrBefore` are considered, so a consumer sees exactly the
   * revision that was live when its execution began — a revision published after
   * that instant is invisible to it. Omitted ⇒ the absolute latest.
   */
  getLatestRuntimeExport(
    sessionId: string,
    producerRuntimeId: string,
    recordAs: string,
    opts?: { readonly atOrBefore?: string },
  ): Promise<RuntimeExportRecord | null>;
  /**
   * List a session's exports, ordered by `(producerRuntimeId, recordAs,
   * revision)` ascending — so within each export series revisions run oldest to
   * newest. Optionally narrowed to one `producerRuntimeId` and/or `recordAs`.
   * `latestOnly` returns only the highest revision of each matching series.
   */
  listRuntimeExports(
    sessionId: string,
    filter?: {
      readonly producerRuntimeId?: string;
      readonly recordAs?: string;
      readonly latestOnly?: boolean;
    },
  ): Promise<readonly RuntimeExportRecord[]>;
}

/** Materialized state snapshots. Part of `sql-snapshot-records`. */
export interface SnapshotStore {
  /**
   * Persist a materialized state snapshot. Used by auto / manual / fork flows.
   * Upsert semantics: re-saving the same id replaces the payload.
   */
  saveSnapshot(record: SnapshotRecord): Promise<void>;
  getSnapshot(id: string): Promise<SnapshotRecord | null>;
  /** List snapshots for a session, ordered by `createdAt` asc. */
  listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]>;
  /**
   * Keyset page of snapshot **metadata** (no payload), newest-first window.
   * `before` omitted ⇒ the newest `limit` snapshots; `before` set ⇒ the `limit`
   * snapshots immediately older than that `(createdAt, id)` position. Rows are
   * returned oldest-first within the page (mirrors {@link MessageStore.listMessagesPage}).
   *
   * The payload column is never selected/deserialized — a snapshot payload
   * serializes the full session state, so listing must stay O(limit) rows and
   * O(1) payloads. `size` is the payload's serialized character length,
   * computed at the DB layer.
   */
  listSnapshotsPage(
    sessionId: string,
    opts: CursorPageOpts,
  ): Promise<readonly SnapshotMetadata[]>;
  /**
   * Delete a session's `auto` snapshots older than its newest `keep`, never
   * one that a fork still names as `parentId`. Manual and fork snapshots are
   * kept. Returns how many snapshots were deleted.
   */
  pruneAutoSnapshots(sessionId: string, keep: number): Promise<number>;
}

/**
 * Transaction control. Held separate from the data domains because
 * {@link StoreTransaction} omits `withTransaction` — a transaction body must
 * not open a nested transaction from inside the scope.
 */
export interface TransactionalStore {
  /**
   * Run `fn` inside a scoped transaction and return its result.
   *
   * `fn` receives a transaction-bound store view ({@link StoreTransaction}).
   * All writes made through that view commit atomically when `fn` resolves and
   * roll back if it throws (the error is re-thrown to the caller). No
   * shared/global handle is mutated, so concurrent `withTransaction` calls are
   * isolated and never swallow each other's writes:
   *
   * - PostgreSQL runs each call on an independent pooled connection (Drizzle's
   *   native `db.transaction`), giving true concurrency. A non-tx write made
   *   during a transaction stays isolated on its own connection.
   * - Single-connection/snapshot backends (SQLite / Memory)
   *   serialize transactions and bundled root mutators through one write gate,
   *   so an unrelated root write waits instead of being folded into a rollback.
   *   SQLite gates every store sharing its connection.
   *
   * **Nesting is not supported on any backend.** Calling `withTransaction` from
   * inside another `withTransaction` callback rejects with a clear error rather
   * than (serialized backends) deadlocking on the serialization chain or (PG)
   * silently running a non-atomic inner transaction on a separate connection.
   * The bundled backends use a precise async-context guard to distinguish
   * nested calls from genuinely concurrent transactions.
   *
   * Every store implements this boundary. Test doubles should use a bundled
   * in-memory store or provide the same transactional contract explicitly.
   */
  withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}

/** Store lifecycle. Omitted from {@link StoreTransaction}. */
export interface StoreLifecycle {
  close(): Promise<void>;
}

// ── DataStore interface ──────────────────────────────────────────
//
// Cross-composition of the domain sub-interfaces above. The member set is
// identical to the previous flat declaration (96 method members across 19
// data domains plus TransactionalStore and StoreLifecycle);
// `extends` simply names the seams. Downstream consumers keep importing
// `DataStore` with no shape change, and `StoreTransaction` (below) keeps
// working because every omitted key still resolves through these bases.

export interface DataStore
  extends
    SessionStore,
    RuntimeRecordStore,
    StateStore,
    EventStore,
    MessageStore,
    CharacterStore,
    PluginDataStore,
    WorldStore,
    ServerSettingStore,
    TraceStore,
    TurnMessageStore,
    PlayerInputStore,
    WorldDataImportLedgerStore,
    LorebookStore,
    SessionSummaryStore,
    SuspensionStore,
    SnapshotStore,
    LifecycleStore,
    ExportStore,
    TransactionalStore,
    StoreLifecycle {}

/**
 * The transaction-scoped store view passed to {@link DataStore.withTransaction}.
 *
 * Exposes every data read/write method but omits the transaction-control and
 * lifecycle methods — a transaction body must not begin/commit/close from
 * inside the scope.
 */
export type StoreTransaction = Omit<DataStore, "withTransaction" | "close"> & {
  /**
   * Run `fn` in a savepoint nested in the open transaction. A throw rolls back
   * only the writes made inside `fn` and rethrows; the enclosing transaction
   * stays open and keeps everything written before the savepoint. Every
   * bundled backend provides it on its transaction scope; it is optional so a
   * root store still satisfies this type where a scope is accepted.
   */
  savepoint?<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
};

// ── Store config ─────────────────────────────────────────────────

export type StoreBackend = "memory" | "sqlite" | "pg";
export type RuntimeStoreBackend = StoreBackend;

export interface StoreConfig {
  readonly backend: StoreBackend;
  /** SQLite file path (default: ./data/covel.db) */
  readonly sqlitePath?: string;
  /** PostgreSQL connection URL */
  readonly databaseUrl?: string;
}
