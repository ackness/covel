/**
 * SQLite row→record mappers and compatibility exports.
 *
 * The actual mapping logic lives in the backend-agnostic
 * `../common/mappers.ts`; this module is only the SQLite serialization
 * gateway. SQLite stores JSON columns as text, so the canonical mappers are
 * bound to {@link sqliteJsonReader} which parses them. Each export keeps its
 * historical single-argument `(row)` signature.
 *
 * Suspensions and snapshots are persisted via raw SQL (not drizzle), so they
 * arrive as snake_case rows and get adapted to the canonical camelCase shape
 * before mapping.
 *
 * Scope note: this gateway only covers the record domains that are NOT yet
 * routed through the shared `common/sql-*-records.ts` query layer (session,
 * session content/journal, plugin configs, snapshot, suspension). The world /
 * plugin-data / working-memory / lorebook / state / runtime mappers moved to
 * direct canonical calls inside the shared query modules, so their SQLite
 * wrappers were removed.
 */

import { sqliteJsonReader } from "../common/json-readers.js";
import * as canonical from "../common/mappers.js";
import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginConfigRecord,
  SessionRecord,
  SessionSummaryRecord,
  SnapshotRecord,
  SuspensionRecord,
  TraceEventRecord,
  TurnMessageRecord,
} from "../types.js";
import type * as schema from "./schema.js";

export { toJson, fromJson, fromJsonRequired } from "./sqlite-json.js";
export { createTables } from "./sqlite-schema-ddl.js";

// ── Row → Record mappers (SQLite gateway, JSON columns are text) ──

export function toSessionRecord(
  row: typeof schema.sessions.$inferSelect,
): SessionRecord {
  return canonical.toSessionRecord(row, sqliteJsonReader);
}

export function toEventRecord(
  row: typeof schema.events.$inferSelect,
): EventRecord {
  return canonical.toEventRecord(row, sqliteJsonReader);
}

export function toApprovalRecord(
  row: typeof schema.approvals.$inferSelect,
): ApprovalRecord {
  return canonical.toApprovalRecord(row);
}

export function toMessageRecord(
  row: typeof schema.messages.$inferSelect,
): MessageRecord {
  return canonical.toMessageRecord(row, sqliteJsonReader);
}

export function toCharacterRecord(
  row: typeof schema.characters.$inferSelect,
): CharacterRecord {
  return canonical.toCharacterRecord(row, sqliteJsonReader);
}

export function toPluginConfigRecord(
  row: typeof schema.pluginConfigs.$inferSelect,
): PluginConfigRecord {
  return canonical.toPluginConfigRecord(row, sqliteJsonReader);
}

export function toTraceEventRecord(
  row: typeof schema.traceEvents.$inferSelect,
): TraceEventRecord {
  return canonical.toTraceEventRecord(row, sqliteJsonReader);
}

export function toTurnMessageRecord(
  row: typeof schema.turnMessages.$inferSelect,
): TurnMessageRecord {
  return canonical.toTurnMessageRecord(row, sqliteJsonReader);
}

export function toPlayerInputRecord(
  row: typeof schema.playerInputs.$inferSelect,
): PlayerInputRecord {
  return canonical.toPlayerInputRecord(row, sqliteJsonReader);
}

export function toSessionSummaryRecord(
  row: typeof schema.sessionSummaries.$inferSelect,
): SessionSummaryRecord {
  return canonical.toSessionSummaryRecord(row, sqliteJsonReader);
}

// ── Suspension row type (not in drizzle schema, raw sqlite) ─────

interface SuspensionRow {
  id: string;
  session_id: string;
  turn_id: string;
  runtime_id: string;
  plugin_id: string;
  reason: string;
  resume_schema: string;
  pending_continuation: string;
  created_at: string;
  resolved_at: string | null;
}

export function toSuspensionRecord(row: SuspensionRow): SuspensionRecord {
  return canonical.toSuspensionRecord(
    {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      runtimeId: row.runtime_id,
      pluginId: row.plugin_id,
      reason: row.reason,
      resumeSchema: row.resume_schema,
      pendingContinuation: row.pending_continuation,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    },
    sqliteJsonReader,
  );
}

export type { SuspensionRow };

// ── Snapshot row type (not in drizzle schema, raw sqlite) ──────

interface SnapshotRow {
  id: string;
  session_id: string;
  turn_id: string;
  kind: string;
  parent_id: string | null;
  payload: string;
  created_at: string;
}

export function toSnapshotRecord(row: SnapshotRow): SnapshotRecord {
  return canonical.toSnapshotRecord(
    {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      kind: row.kind,
      parentId: row.parent_id,
      payload: row.payload,
      createdAt: row.created_at,
    },
    sqliteJsonReader,
  );
}

export type { SnapshotRow };
