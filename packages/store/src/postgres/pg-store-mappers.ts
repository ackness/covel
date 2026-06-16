/**
 * PostgreSQL row→record mappers and compatibility exports.
 *
 * The actual mapping logic lives in the backend-agnostic
 * `../common/mappers.ts`; this module is only the PostgreSQL serialization
 * gateway. PG `jsonb` columns arrive already deserialized, so the canonical
 * mappers are bound to {@link pgJsonReader} (an identity/`null`-collapse
 * reader). Each export keeps its historical single-argument `(row)` signature.
 */

import * as canonical from "../common/mappers.js";
import { pgJsonReader } from "../common/json-readers.js";
import type * as schema from "./schema.js";
import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginConfigRecord,
  PluginDataRecord,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  SessionRecord,
  SessionSummaryRecord,
  SnapshotRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
  SuspensionRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";

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

export function toWorldRecord(
  row: typeof schema.worlds.$inferSelect,
): WorldRecord {
  return canonical.toWorldRecord(row, pgJsonReader);
}

export function toTurnResultRecord(
  row: typeof schema.turnResults.$inferSelect,
): TurnResultRecord {
  return canonical.toTurnResultRecord(row, pgJsonReader);
}

export function toRuntimeResultRecord(
  row: typeof schema.runtimeResults.$inferSelect,
): RuntimeResultRecord {
  return canonical.toRuntimeResultRecord(row, pgJsonReader);
}

export function toToolCallRecord(
  row: typeof schema.toolCalls.$inferSelect,
): ToolCallRecordRow {
  return canonical.toToolCallRecord(row, pgJsonReader);
}

export function toStateSchemaRecord(
  row: typeof schema.stateSchemas.$inferSelect,
): StateSchemaRecord {
  return canonical.toStateSchemaRecord(row, pgJsonReader);
}

export function toStateEntryRecord(
  row: typeof schema.stateEntries.$inferSelect,
): StateEntryRecord {
  return canonical.toStateEntryRecord(row, pgJsonReader);
}

export function toStateChangeRecord(
  row: typeof schema.stateChanges.$inferSelect,
): StateChangeRecord {
  return canonical.toStateChangeRecord(row, pgJsonReader);
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

export function toPluginDataRecord(
  row: typeof schema.pluginData.$inferSelect,
): PluginDataRecord {
  return canonical.toPluginDataRecord(row, pgJsonReader);
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

export function toRuntimeOutputRecord(
  row: typeof schema.runtimeOutputs.$inferSelect,
): RuntimeOutputRecord {
  return canonical.toRuntimeOutputRecord(row, pgJsonReader);
}

export function toInteractionRecordRow(
  row: typeof schema.interactionRecords.$inferSelect,
): InteractionRecordRow {
  return canonical.toInteractionRecordRow(row, pgJsonReader);
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

export function toWorkingMemoryRecord(
  row: typeof schema.workingMemory.$inferSelect,
): WorkingMemoryRecord {
  return canonical.toWorkingMemoryRecord(row, pgJsonReader);
}

export function toWorldDataImportLedgerRecord(
  row: typeof schema.worldDataImportLedger.$inferSelect,
): WorldDataImportLedgerRecord {
  return canonical.toWorldDataImportLedgerRecord(row, pgJsonReader);
}

export function toLorebookEntryRecord(
  row: typeof schema.lorebookEntries.$inferSelect,
): LorebookEntryRecord {
  return canonical.toLorebookEntryRecord(row, pgJsonReader);
}

export function toSessionSummaryRecord(
  row: typeof schema.sessionSummaries.$inferSelect,
): SessionSummaryRecord {
  return canonical.toSessionSummaryRecord(row, pgJsonReader);
}

export function toSnapshotRecord(
  row: typeof schema.stateSnapshots.$inferSelect,
): SnapshotRecord {
  return canonical.toSnapshotRecord(row, pgJsonReader);
}

export function toSuspensionRecord(
  row: typeof schema.suspensions.$inferSelect,
): SuspensionRecord {
  return canonical.toSuspensionRecord(row, pgJsonReader);
}
