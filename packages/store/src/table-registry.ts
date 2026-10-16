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

/**
 * Keys of {@link MemoryState} that back a session-scoped collection — a `Map`
 * or array of rows that each carry a `sessionId`. Typing `memoryKey` against
 * this union makes a typo or a stale key a compile error.
 */
export type SessionScopedMemoryKey = Extract<
  keyof MemoryState,
  | "turnResults"
  | "toolCalls"
  | "stateSchemas"
  | "stateEntries"
  | "stateChanges"
  | "events"
  | "messages"
  | "characters"
  | "characterSchemas"
  | "pluginData"
  | "vectorIndexProgress"
  | "worldDataImportLedger"
  | "traceEvents"
  | "runtimeOutputs"
  | "interactionRecords"
  | "turnMessages"
  | "playerInputs"
  | "lorebookEntries"
  | "sessionSummaries"
  | "suspensions"
  | "snapshots"
  | "logicalTurnLedger"
  | "setupAttempts"
  | "jobStatus"
  | "runtimeExports"
  | "recordChanges"
  | "sessionWriteCounters"
>;

export type MemoryCollectionKind = "map" | "array";

export interface SessionScopedTable {
  /** SQL table name (snake_case) — matches the Drizzle schema + hand DDL. */
  readonly table: string;
  /** {@link MemoryState} collection that backs this table in MemoryStore. */
  readonly memoryKey: SessionScopedMemoryKey;
  /** Whether the MemoryState collection is a `Map` or an array. */
  readonly memoryKind: MemoryCollectionKind;
}

/**
 * Every session-scoped child table, in cascade order (children deleted before
 * the parent `sessions` row). With zero declared foreign keys the order is
 * load-bearing in one place only: `record_changes` and `session_write_counters`
 * come last, because deleting the lorebook, character and plugin data rows
 * fires triggers that write to them (`common/write-order-ddl.ts`).
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTable[] = [
  {
    table: "vector_index_progress",
    memoryKey: "vectorIndexProgress",
    memoryKind: "map",
  },
  {
    table: "turn_results",
    memoryKey: "turnResults",
    memoryKind: "array",
  },
  {
    table: "tool_calls",
    memoryKey: "toolCalls",
    memoryKind: "array",
  },
  {
    table: "state_schemas",
    memoryKey: "stateSchemas",
    memoryKind: "array",
  },
  {
    table: "state_entries",
    memoryKey: "stateEntries",
    memoryKind: "map",
  },
  {
    table: "state_changes",
    memoryKey: "stateChanges",
    memoryKind: "array",
  },
  {
    table: "events",
    memoryKey: "events",
    memoryKind: "array",
  },
  {
    table: "messages",
    memoryKey: "messages",
    memoryKind: "array",
  },
  {
    table: "character_schemas",
    memoryKey: "characterSchemas",
    memoryKind: "map",
  },
  {
    table: "characters",
    memoryKey: "characters",
    memoryKind: "map",
  },
  {
    table: "plugin_data",
    memoryKey: "pluginData",
    memoryKind: "map",
  },
  {
    table: "world_data_import_ledger",
    memoryKey: "worldDataImportLedger",
    memoryKind: "map",
  },
  {
    table: "trace_events",
    memoryKey: "traceEvents",
    memoryKind: "array",
  },
  {
    table: "runtime_outputs",
    memoryKey: "runtimeOutputs",
    memoryKind: "array",
  },
  {
    table: "interaction_records",
    memoryKey: "interactionRecords",
    memoryKind: "array",
  },
  {
    table: "turn_messages",
    memoryKey: "turnMessages",
    memoryKind: "array",
  },
  {
    table: "player_inputs",
    memoryKey: "playerInputs",
    memoryKind: "array",
  },
  {
    table: "lorebook_entries",
    memoryKey: "lorebookEntries",
    memoryKind: "map",
  },
  {
    table: "session_summaries",
    memoryKey: "sessionSummaries",
    memoryKind: "array",
  },
  {
    table: "suspensions",
    memoryKey: "suspensions",
    memoryKind: "map",
  },
  {
    table: "state_snapshots",
    memoryKey: "snapshots",
    memoryKind: "map",
  },
  {
    table: "logical_turn_ledger",
    memoryKey: "logicalTurnLedger",
    memoryKind: "map",
  },
  {
    table: "setup_attempts",
    memoryKey: "setupAttempts",
    memoryKind: "map",
  },
  {
    table: "job_status",
    memoryKey: "jobStatus",
    memoryKind: "map",
  },
  {
    table: "runtime_exports",
    memoryKey: "runtimeExports",
    memoryKind: "map",
  },
  // Last: the triggers of the tables above write to these two.
  {
    table: "record_changes",
    memoryKey: "recordChanges",
    memoryKind: "map",
  },
  {
    table: "session_write_counters",
    memoryKey: "sessionWriteCounters",
    memoryKind: "map",
  },
];

/** SQL names of the session-scoped child tables, in cascade order. */
export const SESSION_SCOPED_TABLE_NAMES: readonly string[] =
  SESSION_SCOPED_TABLES.map((t) => t.table);

/** Parent table — deleted last by the cascade, keyed by `id` not `session_id`. */
export const SESSIONS_TABLE = "sessions";
