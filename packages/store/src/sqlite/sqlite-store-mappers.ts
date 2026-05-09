/**
 * SQLite row→record mappers and compatibility exports.
 */

import type { SessionStatus } from "@covel/shared";
import * as schema from "./schema.js";
import type {
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginDataRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotKind,
  SnapshotPayload,
} from "../types.js";

import { fromJson, fromJsonRequired } from "./sqlite-json.js";
export { toJson, fromJson, fromJsonRequired } from "./sqlite-json.js";
export { createTables } from "./sqlite-schema-ddl.js";

// ── Row → Record mappers ────────────────────────────────────────

export function toSessionRecord(
  row: typeof schema.sessions.$inferSelect,
): SessionRecord {
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: (row.status ?? "active") as SessionStatus,
    turnCount: row.turnCount,
    preGameCompleted: row.preGameCompleted
      ? JSON.parse(row.preGameCompleted)
      : [],
    locale: row.locale,
    activePlugins: row.activePlugins ? JSON.parse(row.activePlugins) : [],
    ...(() => {
      const metadata = fromJson(row.metadata) as
        | Record<string, unknown>
        | undefined;
      return {
        metadata,
        ...(typeof metadata?.presetId === "string"
          ? { presetId: metadata.presetId }
          : {}),
      };
    })(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.embeddingModelId != null
      ? { embeddingModelId: row.embeddingModelId }
      : {}),
    ...(row.embeddingLockedAt != null
      ? { embeddingLockedAt: row.embeddingLockedAt }
      : {}),
    ...(() => {
      if (!row.runtimeModelOverrides) return {};
      const parsed = JSON.parse(row.runtimeModelOverrides) as Record<
        string,
        string
      >;
      return Object.keys(parsed).length > 0
        ? { runtimeModelOverrides: parsed as Readonly<Record<string, string>> }
        : {};
    })(),
  };
}

export function toWorldRecord(
  row: typeof schema.worlds.$inferSelect,
): WorldRecord {
  const metadata = fromJson(row.metadata) as
    | Record<string, unknown>
    | undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: fromJson(row.tags) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata,
    dimensions: metadata?.dimensions as WorldRecord["dimensions"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}

export function toTurnResultRecord(
  row: typeof schema.turnResults.$inferSelect,
): TurnResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResults: fromJsonRequired(row.runtimeResults),
    conflicts: fromJson(row.conflicts),
    auditResult: fromJson(row.auditResult),
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export function toRuntimeResultRecord(
  row: typeof schema.runtimeResults.$inferSelect,
): RuntimeResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    status: row.status,
    output: fromJson(row.output),
    toolCalls: fromJson(row.toolCalls),
    durationMs: row.durationMs,
    tokenUsage: fromJson(row.tokenUsage),
    error: row.error ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toToolCallRecord(
  row: typeof schema.toolCalls.$inferSelect,
): ToolCallRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    input: fromJson(row.input),
    output: fromJson(row.output),
    durationMs: row.durationMs,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt,
  };
}

export function toStateSchemaRecord(
  row: typeof schema.stateSchemas.$inferSelect,
): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: fromJsonRequired(row.schema),
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(
  row: typeof schema.stateEntries.$inferSelect,
): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: fromJson(row.value),
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(
  row: typeof schema.stateChanges.$inferSelect,
): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: fromJson(row.value),
    changedBy: row.changedBy,
    turnId: row.turnId,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toEventRecord(
  row: typeof schema.events.$inferSelect,
): EventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    topic: row.topic,
    payload: fromJson(row.payload),
    targetRuntime: row.targetRuntime ?? undefined,
    turnId: row.turnId ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toApprovalRecord(
  row: typeof schema.approvals.$inferSelect,
): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    decision: row.decision,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
}

export function toMessageRecord(
  row: typeof schema.messages.$inferSelect,
): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: fromJson(row.metadata),
    createdAt: row.createdAt,
  };
}

export function toCharacterRecord(
  row: typeof schema.characters.$inferSelect,
): CharacterRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    type: row.type,
    description: row.description ?? undefined,
    fields: fromJson(row.fields),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginDataRecord(
  row: typeof schema.pluginData.$inferSelect,
): PluginDataRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    value: fromJson(row.value),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginConfigRecord(
  row: typeof schema.pluginConfigs.$inferSelect,
): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: fromJsonRequired(row.config),
    updatedAt: row.updatedAt,
  };
}

export function toTraceEventRecord(
  row: typeof schema.traceEvents.$inferSelect,
): TraceEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    traceId: row.traceId,
    turnId: row.turnId,
    payload: fromJson(row.payload),
    createdAt: row.createdAt,
  };
}

export function toRuntimeOutputRecord(
  row: typeof schema.runtimeOutputs.$inferSelect,
): RuntimeOutputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResultId: row.runtimeResultId ?? undefined,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    timestamp: row.timestamp,
    results: fromJsonRequired(row.results),
    metaData: fromJsonRequired(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toInteractionRecordRow(
  row: typeof schema.interactionRecords.$inferSelect,
): InteractionRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? undefined,
    timestamp: row.timestamp,
    source: row.source,
    channel: row.channel,
    type: row.type,
    targetPluginId: row.targetPluginId ?? undefined,
    targetRuntimeId: row.targetRuntimeId ?? undefined,
    payload: fromJsonRequired(row.payload),
    metaData: fromJson(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toTurnMessageRecord(
  row: typeof schema.turnMessages.$inferSelect,
): TurnMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    sourceType: row.sourceType,
    sourcePluginId: row.sourcePluginId ?? undefined,
    sourceRuntimeId: row.sourceRuntimeId ?? undefined,
    role: row.role,
    name: row.name ?? undefined,
    content: row.content,
    ui: fromJson(row.ui),
    pendingInput: fromJson(row.pendingInput),
    order: row.order,
    createdAt: row.createdAt,
    compactedAtTurnId: row.compactedAtTurnId ?? undefined,
  };
}

export function toPlayerInputRecord(
  row: typeof schema.playerInputs.$inferSelect,
): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: fromJsonRequired(row.values),
    createdAt: row.createdAt,
  };
}

export function toWorkingMemoryRecord(
  row: typeof schema.workingMemory.$inferSelect,
): WorkingMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    key: row.key,
    scope: row.scope as WorkingMemoryRecord["scope"],
    value: fromJsonRequired(row.value),
    schemaRef: row.schemaRef ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toWorldDataImportLedgerRecord(
  row: typeof schema.worldDataImportLedger.$inferSelect,
): WorldDataImportLedgerRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    target: row.target,
    pluginId: row.pluginId ?? undefined,
    namespace: row.namespace ?? undefined,
    key: row.key ?? undefined,
    sourceWorldId: row.sourceWorldId,
    sourceId: row.sourceId,
    sourceDigest: row.sourceDigest,
    valueHash: row.valueHash,
    schemaRef: row.schemaRef ?? undefined,
    derivedFrom:
      row.derivedFrom == null
        ? undefined
        : ((fromJsonRequired(row.derivedFrom) as string[] | null) ?? []),
    importedAt: row.importedAt,
    managed: row.managed !== 0,
  };
}

export function toLorebookEntryRecord(
  row: typeof schema.lorebookEntries.$inferSelect,
): LorebookEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    keys: ((fromJsonRequired(row.keys) as string[] | null) ??
      []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord["strategy"],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: row.enabled !== 0,
    extra: row.extra == null ? undefined : fromJsonRequired(row.extra),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSessionSummaryRecord(
  row: typeof schema.sessionSummaries.$inferSelect,
): SessionSummaryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnRangeStart: row.turnRangeStart,
    turnRangeEnd: row.turnRangeEnd,
    content: row.content,
    focusSections:
      (fromJsonRequired(row.focusSections) as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
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
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    runtimeId: row.runtime_id,
    pluginId: row.plugin_id,
    reason: row.reason,
    resumeSchema: fromJsonRequired(row.resume_schema),
    pendingContinuation: fromJsonRequired(
      row.pending_continuation,
    ) as SuspensionRecord["pendingContinuation"],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
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
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    kind: row.kind as SnapshotKind,
    parentId: row.parent_id ?? undefined,
    payload: fromJsonRequired(row.payload) as SnapshotPayload,
    createdAt: row.created_at,
  };
}

export type { SnapshotRow };
