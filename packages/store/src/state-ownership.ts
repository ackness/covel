/**
 * Kernel-state ownership inventory; this does not drive persistence behavior.
 *
 * Tests check table coverage, scope, snapshot datasets and checkpoint domains.
 * Fork policies describe apps/server/src/routes/api/snapshots.ts and are NOT
 * verified here: store tests cannot depend on the server package.
 * Session metadata sub-keys, reset (no path exists) and future operation records
 * are outside this inventory's checks.
 */

import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type * as sqliteSchema from "./sqlite/schema.js";
import type { SessionRecord } from "./records/session-records.js";

/** Derived from actual tables, rather than a second hand-maintained name list. */
export type StoreTableName = Extract<
  (typeof sqliteSchema)[keyof typeof sqliteSchema],
  SQLiteTable
>["_"]["name"];

export interface TableOwnership {
  readonly owner: "kernel" | "plugin";
  readonly scope: "session" | "global";
  readonly snapshot: "captured" | "excluded" | "not-applicable";
  readonly checkpoint: "exported" | "excluded" | "not-applicable";
  readonly fork: "copied" | "rebuilt" | "excluded" | "not-applicable";
  readonly note?: string;
}

export interface FieldOwnership {
  readonly owner: "kernel";
  readonly snapshot: "captured" | "excluded";
  readonly note?: string;
}

export const KERNEL_TABLE_OWNERSHIP: Readonly<
  Record<StoreTableName, TableOwnership>
> = {
  worlds: {
    owner: "kernel",
    scope: "global",
    snapshot: "not-applicable",
    checkpoint: "exported",
    fork: "not-applicable",
    note: "Checkpoint carries the bound world; forks retain its shared identity.",
  },
  server_settings: {
    owner: "kernel",
    scope: "global",
    snapshot: "not-applicable",
    checkpoint: "not-applicable",
    fork: "not-applicable",
  },
  sessions: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "rebuilt",
    note: "Parent row; snapshot captures only SnapshotSessionState fields.",
  },
  turn_results: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
    note: "Checkpoint retains a bounded recent execution window.",
  },
  tool_calls: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
    note: "Checkpoint schema includes the array; current exporter emits it empty.",
  },
  events: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
    note: "Checkpoint schema includes the array; current exporter emits it empty.",
  },
  messages: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "copied",
    note: "Snapshot holds a display boundary, not rows; fork copies its prefix.",
  },
  character_schemas: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
  },
  characters: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
  },
  plugin_data: {
    owner: "plugin",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
    note: "Rows are owned by plugin_id; _ namespaces and __kernel: owners (KERNEL_PLUGIN_DATA_OWNER_PREFIX) are kernel partitions. Control-plane namespaces are excluded from snapshots and forks.",
  },
  world_data_import_ledger: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  trace_events: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
    note: "Checkpoint carries only execution recovery trace types.",
  },
  runtime_outputs: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
    note: "Checkpoint retains a bounded recent execution window.",
  },
  interaction_records: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  turn_messages: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "copied",
    note: "Snapshot captures cursor and compaction tags, not message rows.",
  },
  session_summaries: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
    note: "Snapshot captures only summaries referenced by captured message tags.",
  },
  player_inputs: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  media_assets: {
    owner: "kernel",
    scope: "global",
    snapshot: "not-applicable",
    checkpoint: "excluded",
    fork: "not-applicable",
    note: "MediaStore owns asset bytes; payload MediaRef values are references.",
  },
  media_refs: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "excluded",
    fork: "rebuilt",
    note: "MediaStore lifecycle; forks rebuild references from copied content.",
  },
  lorebook_entries: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
  },
  state_snapshots: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "rebuilt",
    note: "Fork creates a provenance snapshot, not a copy of snapshot history.",
  },
  suspensions: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
    note: "Only unresolved, unclaimed suspensions enter snapshots and forks.",
  },
  logical_turn_ledger: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  setup_attempts: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  job_status: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "exported",
    fork: "excluded",
  },
  runtime_exports: {
    owner: "kernel",
    scope: "session",
    snapshot: "captured",
    checkpoint: "exported",
    fork: "copied",
    note: "Snapshot captures latest revisions; checkpoint may retain older revisions for unfinished jobs.",
  },
  vector_models: {
    owner: "kernel",
    scope: "global",
    snapshot: "not-applicable",
    checkpoint: "not-applicable",
    fork: "not-applicable",
  },
  vector_index_progress: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "excluded",
    fork: "rebuilt",
    note: "Each session rebuilds its derived vector index and progress.",
  },
  session_write_counters: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "excluded",
    fork: "rebuilt",
    note: "Derived by writes in the new session, not copied from the parent.",
  },
  record_changes: {
    owner: "kernel",
    scope: "session",
    snapshot: "excluded",
    checkpoint: "excluded",
    fork: "rebuilt",
    note: "Derived by writes in the new session, not copied from the parent.",
  },
};

export const SESSION_FIELD_OWNERSHIP: Readonly<
  Record<keyof SessionRecord, FieldOwnership>
> = {
  id: { owner: "kernel", snapshot: "excluded" },
  worldId: { owner: "kernel", snapshot: "excluded" },
  status: { owner: "kernel", snapshot: "captured" },
  locale: { owner: "kernel", snapshot: "captured" },
  activePlugins: { owner: "kernel", snapshot: "captured" },
  createdAt: { owner: "kernel", snapshot: "excluded" },
  updatedAt: { owner: "kernel", snapshot: "excluded" },
  metadata: {
    owner: "kernel",
    snapshot: "excluded",
    note: "Not captured wholesale; promoted metadata sub-keys in SnapshotSessionState are outside field coverage.",
  },
  embeddingModelId: { owner: "kernel", snapshot: "excluded" },
  embeddingLockedAt: { owner: "kernel", snapshot: "excluded" },
  runtimeModelOverrides: { owner: "kernel", snapshot: "captured" },
  phase: { owner: "kernel", snapshot: "captured" },
  completedPlayerTurns: { owner: "kernel", snapshot: "captured" },
  setupRuntimes: { owner: "kernel", snapshot: "captured" },
  seats: { owner: "kernel", snapshot: "captured" },
};
