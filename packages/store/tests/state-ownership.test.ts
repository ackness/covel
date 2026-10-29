/**
 * Inventory drift checks only. Fork behavior lives in apps/server and is
 * declared, not verified, here. Metadata sub-keys and reset are out of scope.
 */

import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type {
  BrowserCheckpoint,
  BrowserCheckpointState,
} from "../src/browser-sync/browser-sync.js";
import {
  checkpointLifecycleArrays,
  snapshotPayloadSchema,
} from "../src/browser-sync/checkpoint-lifecycle-schemas.js";
import { checkpointRecordArrays } from "../src/browser-sync/checkpoint-record-schemas.js";
import * as pgSchema from "../src/postgres/schema.js";
import type { SessionRecord } from "../src/records/session-records.js";
import type {
  SnapshotPayload,
  SnapshotSessionState,
} from "../src/records/snapshot-records.js";
import * as sqliteSchema from "../src/sqlite/schema.js";
import {
  KERNEL_TABLE_OWNERSHIP,
  SESSION_FIELD_OWNERSHIP,
  type StoreTableName,
} from "../src/state-ownership.js";
import {
  SESSION_SCOPED_TABLE_NAMES,
  SESSIONS_TABLE,
} from "../src/table-registry.js";

// Account for every key, including envelope fields and historical boundaries.
// A cursor or partial tag projection does not capture a table's row dataset.
const SNAPSHOT_TABLES = {
  schemaVersion: null,
  session: "sessions",
  turnId: null,
  characterSchema: "character_schemas",
  characters: "characters",
  stateEntries: "state_entries",
  stateSchemas: "state_schemas",
  runtimeExports: "runtime_exports",
  pluginData: "plugin_data",
  sessionSummaries: "session_summaries",
  compactedMessageSummaryIds: null,
  lorebookEntries: "lorebook_entries",
  suspensions: "suspensions",
  messagesCursor: null,
  displayMessagesBoundary: null,
} satisfies Record<keyof SnapshotPayload, StoreTableName | null>;

// Both the runtime schemas and the public checkpoint contract must stay mapped.
const CHECKPOINT_ARRAY_TABLES = {
  messages: "messages",
  turnMessages: "turn_messages",
  turnResults: "turn_results",
  toolCalls: "tool_calls",
  runtimeOutputs: "runtime_outputs",
  interactions: "interaction_records",
  events: "events",
  traceEvents: "trace_events",
  characters: "characters",
  pluginData: "plugin_data",
  lorebookEntries: "lorebook_entries",
  sessionSummaries: "session_summaries",
  playerInputs: "player_inputs",
  worldDataLedger: "world_data_import_ledger",
  suspensions: "suspensions",
  snapshots: "state_snapshots",
  logicalTurnLedger: "logical_turn_ledger",
  setupAttempts: "setup_attempts",
  jobStatus: "job_status",
  runtimeExports: "runtime_exports",
} satisfies Record<
  keyof typeof checkpointRecordArrays | keyof typeof checkpointLifecycleArrays,
  StoreTableName
>;

const CHECKPOINT_STATE_TABLES = {
  schemas: "state_schemas",
  entries: "state_entries",
  changes: "state_changes",
} satisfies Record<keyof BrowserCheckpointState, StoreTableName>;

const CHECKPOINT_TABLES = {
  ...CHECKPOINT_ARRAY_TABLES,
  schemaVersion: null,
  sessionId: null,
  profile: null,
  session: "sessions",
  world: "worlds",
  characterSchema: "character_schemas",
  state: Object.values(CHECKPOINT_STATE_TABLES),
  revision: null,
  actionId: null,
  committedAt: null,
} satisfies Record<
  keyof BrowserCheckpoint,
  StoreTableName | readonly StoreTableName[] | null
>;

// Metadata projections are not SessionRecord fields. Keeping explicit nulls
// acknowledges them without inventing ownership rules for metadata sub-keys.
const SNAPSHOT_SESSION_FIELDS = {
  status: "status",
  phase: "phase",
  completedPlayerTurns: "completedPlayerTurns",
  setupRuntimes: "setupRuntimes",
  locale: "locale",
  activePlugins: "activePlugins",
  runtimeModelOverrides: "runtimeModelOverrides",
  loreOverride: null,
  dimensionProviderPluginId: null,
} satisfies Record<keyof SnapshotSessionState, keyof SessionRecord | null>;

// Same Drizzle export walker as table-registry-consistency.test.ts, with the
// table guard kept narrow so getTableName needs no unchecked cast.
function drizzleTableNames(schema: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (is(value, SQLiteTable) || is(value, PgTable)) {
      names.add(getTableName(value));
    }
  }
  return names;
}

describe("kernel-state ownership", () => {
  it.each([
    ["SQLite", sqliteSchema],
    ["PostgreSQL", pgSchema],
  ] as const)("registers exactly every %s table", (_backend, schema) => {
    expect(new Set(Object.keys(KERNEL_TABLE_OWNERSHIP))).toEqual(
      drizzleTableNames(schema),
    );
  });

  it("matches session scope, including the parent and MediaStore references", () => {
    const sessionTables = new Set([
      ...SESSION_SCOPED_TABLE_NAMES,
      SESSIONS_TABLE, // Parent is keyed by id, not in the child cascade registry.
      "media_refs", // MediaStore manages its own lifecycle.
    ]);
    for (const [table, ownership] of Object.entries(KERNEL_TABLE_OWNERSHIP)) {
      expect(ownership.scope === "session", table).toBe(
        sessionTables.has(table),
      );
    }
  });

  it("matches captured snapshot datasets rather than cursors or boundaries", () => {
    expect(new Set(Object.keys(SNAPSHOT_TABLES))).toEqual(
      new Set(Object.keys(snapshotPayloadSchema.shape)),
    );
    const capturedTables = new Set<string | null>(
      Object.values(SNAPSHOT_TABLES),
    );
    for (const [table, ownership] of Object.entries(KERNEL_TABLE_OWNERSHIP)) {
      expect(ownership.snapshot === "captured", table).toBe(
        capturedTables.has(table),
      );
    }
  });

  it("matches exported checkpoint domains, including singletons and nested state", () => {
    expect(new Set(Object.keys(CHECKPOINT_ARRAY_TABLES))).toEqual(
      new Set([
        ...Object.keys(checkpointRecordArrays),
        ...Object.keys(checkpointLifecycleArrays),
      ]),
    );
    const exportedTables = new Set<string>(
      Object.values(CHECKPOINT_TABLES).flatMap((value) =>
        value === null ? [] : value,
      ),
    );
    for (const [table, ownership] of Object.entries(KERNEL_TABLE_OWNERSHIP)) {
      expect(ownership.checkpoint === "exported", table).toBe(
        exportedTables.has(table),
      );
    }
  });

  it("matches captured SessionRecord fields", () => {
    const capturedFields = new Set<string | null>(
      Object.values(SNAPSHOT_SESSION_FIELDS),
    );
    for (const [field, ownership] of Object.entries(SESSION_FIELD_OWNERSHIP)) {
      expect(ownership.snapshot === "captured", field).toBe(
        capturedFields.has(field),
      );
    }
  });

  it("assigns plugin-data rows to plugins and other state to the kernel", () => {
    for (const [table, ownership] of Object.entries(KERNEL_TABLE_OWNERSHIP)) {
      expect(ownership.owner, table).toBe(
        table === "plugin_data" ? "plugin" : "kernel",
      );
    }
    for (const [field, ownership] of Object.entries(SESSION_FIELD_OWNERSHIP)) {
      expect(ownership.owner, field).toBe("kernel");
    }
  });
});
