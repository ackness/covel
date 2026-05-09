/**
 * PostgreSQL row→record mappers and compatibility exports.
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

export {
  CREATE_MEDIA_TABLES_SQL,
  CREATE_TABLES_SQL,
  ALL_TABLE_NAMES,
  DROP_ALL_SQL,
} from "./pg-schema-ddl.js";

// ── Row → Record mappers ────────────────────────────────────────

export function toSessionRecord(
  row: typeof schema.sessions.$inferSelect,
): SessionRecord {
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: (row.status ?? "active") as SessionStatus,
    turnCount: row.turnCount,
    preGameCompleted: ((row.preGameCompleted as readonly string[] | null) ??
      []) as readonly string[],
    locale: row.locale,
    activePlugins: (row.activePlugins ?? []) as string[],
    ...(() => {
      const metadata = (row.metadata ?? undefined) as
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
    ...(row.runtimeModelOverrides &&
    Object.keys(row.runtimeModelOverrides as object).length > 0
      ? {
          runtimeModelOverrides: row.runtimeModelOverrides as Record<
            string,
            string
          >,
        }
      : {}),
  };
}

export function toWorldRecord(
  row: typeof schema.worlds.$inferSelect,
): WorldRecord {
  const metadata = (row.metadata ?? undefined) as
    | Record<string, unknown>
    | undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: (row.tags ?? undefined) as string[] | undefined,
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
    runtimeResults: row.runtimeResults ?? null,
    conflicts: row.conflicts ?? undefined,
    auditResult: row.auditResult ?? undefined,
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
    output: row.output ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    durationMs: row.durationMs,
    tokenUsage: row.tokenUsage ?? undefined,
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
    input: row.input ?? undefined,
    output: row.output ?? undefined,
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
    schema: row.schema ?? null,
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
    value: row.value,
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
    value: row.value,
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
    payload: row.payload ?? undefined,
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
    metadata: row.metadata ?? undefined,
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
    fields: row.fields ?? undefined,
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
    value: row.value,
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
    config: row.config ?? null,
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
    payload: row.payload ?? undefined,
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
    results: row.results,
    metaData: row.metaData,
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
    payload: row.payload,
    metaData: row.metaData ?? undefined,
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
    ui: row.ui ?? undefined,
    pendingInput: row.pendingInput ?? undefined,
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
    values: row.values ?? null,
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
    value: row.value ?? null,
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
        : ((row.derivedFrom as string[] | null) ?? []),
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
    keys: ((row.keys as string[] | null) ?? []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord["strategy"],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: row.enabled !== 0,
    extra: row.extra == null ? undefined : row.extra,
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
    focusSections: (row.focusSections as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
}

export function toSnapshotRecord(
  row: typeof schema.stateSnapshots.$inferSelect,
): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    kind: row.kind as SnapshotKind,
    parentId: row.parentId ?? undefined,
    payload: (row.payload ?? {}) as SnapshotPayload,
    createdAt: row.createdAt,
  };
}

export function toSuspensionRecord(
  row: typeof schema.suspensions.$inferSelect,
): SuspensionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeId: row.runtimeId,
    pluginId: row.pluginId,
    reason: row.reason,
    resumeSchema: row.resumeSchema ?? null,
    pendingContinuation: (row.pendingContinuation ??
      {}) as SuspensionRecord["pendingContinuation"],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
