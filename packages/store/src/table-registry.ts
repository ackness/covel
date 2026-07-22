/**
 * Session-scoped table registry — single source of truth.
 *
 * Adding a new session-scoped table used to mean editing ~14 hand-maintained
 * lists (two cascade-delete modules, the PG drop list, the MemoryStore cascade,
 * the MemoryStore transaction snapshot, …). Any omission left silent data
 * residue or broke rollback isolation.
 *
 * Declare a new table HERE once and every derived point picks it up
 * automatically:
 *
 *   - PG cascade delete         → postgres/pg-session-cascade.ts
 *   - SQLite cascade delete      → sqlite/sqlite-session-cascade.ts
 *   - IDB cascade delete         → indexeddb/idb-session-store.ts
 *   - MemoryStore cascade        → memory/session-methods.ts
 *   - MemoryStore tx snapshot    → memory/transaction-methods.ts
 *   - DROP list / ALL_TABLE_NAMES → postgres/pg-schema-ddl.ts
 *
 * The registry intentionally lists only the *child* tables keyed by a
 * `session_id` column. The parent `sessions` row is deleted last by the cascade
 * modules (keyed by `id`), and non-session-scoped tables (`worlds`, media,
 * vector models) are handled by their own subsystems.
 *
 * Consistency between this registry and the real Drizzle schema / DDL /
 * MemoryState shape is pinned by `tests/table-registry-consistency.test.ts`, so
 * a schema table with a `session_id` column that is missing here fails CI.
 *
 * Schema single source of truth: this registry unifies the *table-name* level
 * (cascade / drop list / snapshot). The *column-level* schema is now unified
 * too — the boot DDL in `sqlite/sqlite-schema-ddl.ts` and
 * `postgres/pg-schema-ddl.ts` is DERIVED from the two Drizzle schemas
 * (`sqlite/schema.ts`, `postgres/schema.ts`) via `common/ddl-codegen.ts`, so a
 * column is declared exactly once (in Drizzle). Only Drizzle-unmodelable pieces
 * (PG/SQLite triggers, idempotent in-place column migrations) remain
 * hand-written next to the boot path. Parity is pinned by
 * `tests/schema-ddl-codegen.test.ts` + `tests/schema-index-consistency.test.ts`.
 */

import type { MemoryState } from "./memory/memory-types.js";
import type { IdbStoreName } from "./indexeddb/idb-db.js";

/**
 * Keys of {@link MemoryState} that back a session-scoped collection — a `Map`
 * or array of rows that each carry a `sessionId`. Typing `memoryKey` against
 * this union makes a typo or a stale key a compile error.
 */
export type SessionScopedMemoryKey = Extract<
  keyof MemoryState,
  | "turnResults"
  | "runtimeResults"
  | "toolCalls"
  | "stateSchemas"
  | "stateEntries"
  | "stateChanges"
  | "events"
  | "approvals"
  | "messages"
  | "characters"
  | "pluginData"
  | "worldDataImportLedger"
  | "traceEvents"
  | "runtimeOutputs"
  | "interactionRecords"
  | "turnMessages"
  | "playerInputs"
  | "workingMemoryEntries"
  | "lorebookEntries"
  | "sessionSummaries"
  | "suspensions"
  | "snapshots"
  | "logicalTurnLedger"
  | "setupAttempts"
  | "jobStatus"
>;

export type MemoryCollectionKind = "map" | "array";

export interface SessionScopedTable {
  /** SQL table name (snake_case) — matches the Drizzle schema + hand DDL. */
  readonly table: string;
  /** {@link MemoryState} collection that backs this table in MemoryStore. */
  readonly memoryKey: SessionScopedMemoryKey;
  /** Whether the MemoryState collection is a `Map` or an array. */
  readonly memoryKind: MemoryCollectionKind;
  /**
   * Browser IDB object-store name. IDB names are historically inconsistent
   * (some camelCase like `turnResults`, some snake_case like `plugin_data`) and
   * match neither {@link table} nor {@link memoryKey} reliably, so the mapping
   * is declared explicitly. The IDB cascade auto-picks index vs full-scan
   * deletion by whether the store carries a `sessionId` index.
   */
  readonly idbStore: IdbStoreName;
}

/**
 * Every session-scoped child table, in cascade order (children deleted before
 * the parent `sessions` row). With zero declared foreign keys the order is not
 * load-bearing for correctness; it is preserved for stable, diff-friendly DDL
 * and delete ordering.
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTable[] = [
  {
    table: "turn_results",
    memoryKey: "turnResults",
    memoryKind: "array",
    idbStore: "turnResults",
  },
  {
    table: "runtime_results",
    memoryKey: "runtimeResults",
    memoryKind: "array",
    idbStore: "runtimeResults",
  },
  {
    table: "tool_calls",
    memoryKey: "toolCalls",
    memoryKind: "array",
    idbStore: "toolCalls",
  },
  {
    table: "state_schemas",
    memoryKey: "stateSchemas",
    memoryKind: "array",
    idbStore: "stateSchemas",
  },
  {
    table: "state_entries",
    memoryKey: "stateEntries",
    memoryKind: "map",
    idbStore: "stateEntries",
  },
  {
    table: "state_changes",
    memoryKey: "stateChanges",
    memoryKind: "array",
    idbStore: "stateChanges",
  },
  {
    table: "events",
    memoryKey: "events",
    memoryKind: "array",
    idbStore: "events",
  },
  {
    table: "approvals",
    memoryKey: "approvals",
    memoryKind: "array",
    idbStore: "approvals",
  },
  {
    table: "messages",
    memoryKey: "messages",
    memoryKind: "array",
    idbStore: "messages",
  },
  {
    table: "characters",
    memoryKey: "characters",
    memoryKind: "map",
    idbStore: "characters",
  },
  {
    table: "plugin_data",
    memoryKey: "pluginData",
    memoryKind: "map",
    idbStore: "plugin_data",
  },
  {
    table: "world_data_import_ledger",
    memoryKey: "worldDataImportLedger",
    memoryKind: "map",
    idbStore: "world_data_import_ledger",
  },
  {
    table: "trace_events",
    memoryKey: "traceEvents",
    memoryKind: "array",
    idbStore: "traceEvents",
  },
  {
    table: "runtime_outputs",
    memoryKey: "runtimeOutputs",
    memoryKind: "array",
    idbStore: "runtime_outputs",
  },
  {
    table: "interaction_records",
    memoryKey: "interactionRecords",
    memoryKind: "array",
    idbStore: "interaction_records",
  },
  {
    table: "turn_messages",
    memoryKey: "turnMessages",
    memoryKind: "array",
    idbStore: "turnMessages",
  },
  {
    table: "player_inputs",
    memoryKey: "playerInputs",
    memoryKind: "array",
    idbStore: "playerInputs",
  },
  {
    table: "working_memory",
    memoryKey: "workingMemoryEntries",
    memoryKind: "map",
    idbStore: "working_memory",
  },
  {
    table: "lorebook_entries",
    memoryKey: "lorebookEntries",
    memoryKind: "map",
    idbStore: "lorebook_entries",
  },
  {
    table: "session_summaries",
    memoryKey: "sessionSummaries",
    memoryKind: "array",
    idbStore: "sessionSummaries",
  },
  {
    table: "suspensions",
    memoryKey: "suspensions",
    memoryKind: "map",
    idbStore: "suspensions",
  },
  {
    table: "state_snapshots",
    memoryKey: "snapshots",
    memoryKind: "map",
    idbStore: "state_snapshots",
  },
  {
    table: "logical_turn_ledger",
    memoryKey: "logicalTurnLedger",
    memoryKind: "map",
    idbStore: "logical_turn_ledger",
  },
  {
    table: "setup_attempts",
    memoryKey: "setupAttempts",
    memoryKind: "map",
    idbStore: "setup_attempts",
  },
  {
    table: "job_status",
    memoryKey: "jobStatus",
    memoryKind: "map",
    idbStore: "job_status",
  },
];

/** SQL names of the session-scoped child tables, in cascade order. */
export const SESSION_SCOPED_TABLE_NAMES: readonly string[] =
  SESSION_SCOPED_TABLES.map((t) => t.table);

/** Parent table — deleted last by the cascade, keyed by `id` not `session_id`. */
export const SESSIONS_TABLE = "sessions";
