/**
 * PostgreSQL row→record mappers and compatibility exports.
 *
 * The actual mapping logic lives in the backend-agnostic
 * `../common/mappers.ts`; this module is only the PostgreSQL serialization
 * gateway. PG `jsonb` columns arrive already deserialized, so the canonical
 * mappers are bound to {@link pgJsonReader} (an identity/`null`-collapse
 * reader). Each export keeps its historical single-argument `(row)` signature.
 *
 * Scope note: this gateway only covers the record domains that are NOT yet
 * routed through the shared `common/sql-*-records.ts` query layer (session,
 * session content/journal). The world / plugin-data / working-memory /
 * lorebook / state / runtime / snapshot / suspension mappers moved to direct
 * canonical calls inside the shared query modules, so their PG wrappers were
 * removed.
 */

import { pgJsonReader } from "../common/json-readers.js";
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
  TraceEventRecord,
  TurnMessageRecord,
} from "../types.js";
import type * as schema from "./schema.js";

export {
  CREATE_MEDIA_TABLES_SQL,
  CREATE_TABLES_SQL,
  ALL_TABLE_NAMES,
  DROP_ALL_SQL,
} from "./pg-schema-ddl.js";

// ── Row → Record mappers (PG gateway, jsonb already deserialized) ─

export function toSessionRecord(
  row: typeof schema.sessions.$inferSelect,
): SessionRecord {
  return canonical.toSessionRecord(row, pgJsonReader);
}

export function toEventRecord(
  row: typeof schema.events.$inferSelect,
): EventRecord {
  return canonical.toEventRecord(row, pgJsonReader);
}

export function toApprovalRecord(
  row: typeof schema.approvals.$inferSelect,
): ApprovalRecord {
  return canonical.toApprovalRecord(row);
}

export function toMessageRecord(
  row: typeof schema.messages.$inferSelect,
): MessageRecord {
  return canonical.toMessageRecord(row, pgJsonReader);
}

export function toCharacterRecord(
  row: typeof schema.characters.$inferSelect,
): CharacterRecord {
  return canonical.toCharacterRecord(row, pgJsonReader);
}

export function toPluginConfigRecord(
  row: typeof schema.pluginConfigs.$inferSelect,
): PluginConfigRecord {
  return canonical.toPluginConfigRecord(row, pgJsonReader);
}

export function toTraceEventRecord(
  row: typeof schema.traceEvents.$inferSelect,
): TraceEventRecord {
  return canonical.toTraceEventRecord(row, pgJsonReader);
}

export function toTurnMessageRecord(
  row: typeof schema.turnMessages.$inferSelect,
): TurnMessageRecord {
  return canonical.toTurnMessageRecord(row, pgJsonReader);
}

export function toPlayerInputRecord(
  row: typeof schema.playerInputs.$inferSelect,
): PlayerInputRecord {
  return canonical.toPlayerInputRecord(row, pgJsonReader);
}

export function toSessionSummaryRecord(
  row: typeof schema.sessionSummaries.$inferSelect,
): SessionSummaryRecord {
  return canonical.toSessionSummaryRecord(row, pgJsonReader);
}
