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
 * FOLLOW-UP (deferred — schema single source of truth): this registry unifies
 * the *table-name* level (cascade / drop list / snapshot). It deliberately does
 * NOT yet drive the four column-level schema definitions
 * (`postgres/schema.ts`, `sqlite/schema.ts`, `postgres/pg-schema-ddl.ts`,
 * `sqlite/sqlite-schema-ddl.ts`), which carry backend-specific column types,
 * JSON handling, indexes, and PG triggers. T3 already pinned index drift with a
 * consistency test; collapsing the four column definitions into one source is a
 * larger, higher-risk change tracked as a separate task.
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
  | "pluginConfigs"
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
 * the parent `sessions` row). With zero declared foreign keys the order is not
 * load-bearing for correctness; it is preserved for stable, diff-friendly DDL
 * and delete ordering.
 */
export const SESSION_SCOPED_TABLES: readonly SessionScopedTable[] = [
  { table: "turn_results", memoryKey: "turnResults", memoryKind: "array" },
  {
    table: "runtime_results",
    memoryKey: "runtimeResults",
    memoryKind: "array",
  },
  { table: "tool_calls", memoryKey: "toolCalls", memoryKind: "array" },
  { table: "state_schemas", memoryKey: "stateSchemas", memoryKind: "array" },
  { table: "state_entries", memoryKey: "stateEntries", memoryKind: "map" },
  { table: "state_changes", memoryKey: "stateChanges", memoryKind: "array" },
  { table: "events", memoryKey: "events", memoryKind: "array" },
  { table: "approvals", memoryKey: "approvals", memoryKind: "array" },
  { table: "messages", memoryKey: "messages", memoryKind: "array" },
  { table: "characters", memoryKey: "characters", memoryKind: "map" },
  { table: "plugin_data", memoryKey: "pluginData", memoryKind: "map" },
  {
    table: "world_data_import_ledger",
    memoryKey: "worldDataImportLedger",
    memoryKind: "map",
  },
  { table: "plugin_configs", memoryKey: "pluginConfigs", memoryKind: "map" },
  { table: "trace_events", memoryKey: "traceEvents", memoryKind: "array" },
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
  { table: "turn_messages", memoryKey: "turnMessages", memoryKind: "array" },
  { table: "player_inputs", memoryKey: "playerInputs", memoryKind: "array" },
  {
    table: "working_memory",
    memoryKey: "workingMemoryEntries",
    memoryKind: "map",
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
  { table: "suspensions", memoryKey: "suspensions", memoryKind: "map" },
  { table: "state_snapshots", memoryKey: "snapshots", memoryKind: "map" },
];

/** SQL names of the session-scoped child tables, in cascade order. */
export const SESSION_SCOPED_TABLE_NAMES: readonly string[] =
  SESSION_SCOPED_TABLES.map((t) => t.table);

/** Parent table — deleted last by the cascade, keyed by `id` not `session_id`. */
export const SESSIONS_TABLE = "sessions";
