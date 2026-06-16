/**
 * Backend-agnostic canonical row→record mappers.
 *
 * Both the PostgreSQL and SQLite backends select drizzle rows whose column
 * names already match the camelCase record fields. The ONLY structural
 * difference between them is how JSON columns are read:
 *
 *  - PostgreSQL `jsonb` columns arrive already deserialized as JS values.
 *  - SQLite `text` columns arrive as JSON strings that must be parsed.
 *
 * Each mapper here takes a {@link JsonReader} so the per-backend modules only
 * have to supply that thin serialization gateway. The mappers are otherwise a
 * single canonical definition shared across both SQL backends.
 *
 * `read` mirrors the legacy "optional JSON" behaviour (PG `?? undefined`,
 * SQLite `fromJson`) and `readRequired` mirrors the "required JSON" behaviour
 * (PG `?? null`, SQLite `fromJsonRequired`).
 */

import type { SessionStatus } from "@covel/shared";
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
  SnapshotKind,
  SnapshotPayload,
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

/**
 * Per-backend JSON deserialization gateway injected into the canonical
 * mappers.
 */
export interface JsonReader {
  /** Optional JSON column → value or `undefined` when absent. */
  read(raw: unknown): unknown;
  /** Required JSON column → value or `null` when absent. */
  readRequired(raw: unknown): unknown;
}

// ── Canonical row shapes (camelCase, backend-neutral) ────────────
//
// These describe the minimum field set each mapper consumes. Both drizzle
// `$inferSelect` row types structurally satisfy the corresponding shape, so
// the per-backend modules pass their rows straight through.

export interface SessionRow {
  id: string;
  worldId: string | null;
  status: string | null;
  turnCount: number;
  preGameCompleted: unknown;
  locale: string;
  activePlugins: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  embeddingModelId: number | null;
  embeddingLockedAt: string | null;
  runtimeModelOverrides: unknown;
}

export interface WorldRow {
  id: string;
  name: string;
  description: string;
  lore: string | null;
  tags: unknown;
  locale: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string | null;
}

export interface TurnResultRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeResults: unknown;
  conflicts: unknown;
  auditResult: unknown;
  durationMs: number;
  createdAt: string;
}

export interface RuntimeResultRow {
  id: string;
  sessionId: string;
  turnId: string;
  pluginId: string;
  runtimeId: string;
  status: string;
  output: unknown;
  toolCalls: unknown;
  durationMs: number;
  tokenUsage: unknown;
  error: string | null;
  createdAt: string;
}

export interface ToolCallRow {
  id: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  pluginId: string;
  runtimeId: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  approvalStatus: string;
  createdAt: string;
}

export interface StateSchemaRow {
  id: string;
  sessionId: string;
  tableName: string;
  schema: unknown;
  createdAt: string;
}

export interface StateEntryRow {
  id: string;
  sessionId: string;
  tableName: string;
  fieldName: string;
  value: unknown;
  updatedAt: string;
}

export interface StateChangeRow {
  id: string;
  sessionId: string;
  tableName: string;
  fieldName: string;
  value: unknown;
  changedBy: string;
  turnId: string;
  reason: string | null;
  createdAt: string;
}

export interface EventRow {
  id: string;
  sessionId: string;
  type: string;
  topic: string;
  payload: unknown;
  targetRuntime: string | null;
  turnId: string | null;
  createdAt: string;
}

export interface ApprovalRow {
  id: string;
  sessionId: string;
  toolName: string;
  pluginId: string;
  decision: string;
  turnId: string;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: string;
}

export interface CharacterRow {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  description: string | null;
  fields: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginDataRow {
  id: string;
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PluginConfigRow {
  id: string;
  sessionId: string;
  pluginId: string;
  config: unknown;
  updatedAt: string;
}

export interface TraceEventRow {
  id: string;
  sessionId: string;
  type: string;
  traceId: string;
  turnId: string;
  payload: unknown;
  createdAt: string;
}

export interface RuntimeOutputRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeResultId: string | null;
  pluginId: string;
  runtimeId: string;
  timestamp: string;
  results: unknown;
  metaData: unknown;
  createdAt: string;
}

export interface InteractionRow {
  id: string;
  sessionId: string;
  turnId: string | null;
  timestamp: string;
  source: string;
  channel: string;
  type: string;
  targetPluginId: string | null;
  targetRuntimeId: string | null;
  payload: unknown;
  metaData: unknown;
  createdAt: string;
}

export interface TurnMessageRow {
  id: string;
  sessionId: string;
  turnId: string;
  sourceType: string;
  sourcePluginId: string | null;
  sourceRuntimeId: string | null;
  role: string;
  name: string | null;
  content: string;
  ui: unknown;
  pendingInput: unknown;
  order: number;
  createdAt: string;
  compactedAtTurnId: string | null;
}

export interface PlayerInputRow {
  id: string;
  sessionId: string;
  turnId: string;
  formId: string;
  values: unknown;
  createdAt: string;
}

export interface WorkingMemoryRow {
  id: string;
  sessionId: string;
  key: string;
  scope: string;
  value: unknown;
  schemaRef: string | null;
  updatedAt: string;
}

export interface WorldDataLedgerRow {
  id: string;
  sessionId: string;
  target: string;
  pluginId: string | null;
  namespace: string | null;
  key: string | null;
  sourceWorldId: string;
  sourceId: string;
  sourceDigest: string;
  valueHash: string;
  schemaRef: string | null;
  derivedFrom: unknown;
  importedAt: string;
  managed: number | boolean;
}

export interface LorebookEntryRow {
  id: string;
  sessionId: string;
  pluginId: string;
  keys: unknown;
  content: string;
  strategy: string;
  position: string;
  insertionOrder: number;
  enabled: number | boolean;
  extra: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryRow {
  id: string;
  sessionId: string;
  turnRangeStart: string;
  turnRangeEnd: string;
  content: string;
  focusSections: unknown;
  createdAt: string;
}

export interface SnapshotRow {
  id: string;
  sessionId: string;
  turnId: string;
  kind: string;
  parentId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface SuspensionRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
  reason: string;
  resumeSchema: unknown;
  pendingContinuation: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

/** `managed`/`enabled` come back as `0|1` (SQLite) or boolean (PG). */
function asBoolean(value: number | boolean): boolean {
  return value !== 0 && value !== false;
}

// ── Canonical mappers ────────────────────────────────────────────

export function toSessionRecord(
  row: SessionRow,
  json: JsonReader,
): SessionRecord {
  const metadata = json.read(row.metadata) as
    | Record<string, unknown>
    | undefined;
  const overrides = json.read(row.runtimeModelOverrides) as
    | Record<string, string>
    | undefined;
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: (row.status ?? "active") as SessionStatus,
    turnCount: row.turnCount,
    preGameCompleted: (json.read(row.preGameCompleted) ??
      []) as readonly string[],
    locale: row.locale,
    activePlugins: (json.read(row.activePlugins) ?? []) as readonly string[],
    metadata,
    ...(typeof metadata?.presetId === "string"
      ? { presetId: metadata.presetId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.embeddingModelId != null
      ? { embeddingModelId: row.embeddingModelId }
      : {}),
    ...(row.embeddingLockedAt != null
      ? { embeddingLockedAt: row.embeddingLockedAt }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0
      ? { runtimeModelOverrides: overrides }
      : {}),
  };
}

export function toWorldRecord(row: WorldRow, json: JsonReader): WorldRecord {
  const metadata = json.read(row.metadata) as
    | Record<string, unknown>
    | undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: json.read(row.tags) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata,
    dimensions: metadata?.dimensions as WorldRecord["dimensions"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}

export function toTurnResultRecord(
  row: TurnResultRow,
  json: JsonReader,
): TurnResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResults: json.readRequired(row.runtimeResults),
    conflicts: json.read(row.conflicts),
    auditResult: json.read(row.auditResult),
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export function toRuntimeResultRecord(
  row: RuntimeResultRow,
  json: JsonReader,
): RuntimeResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    status: row.status,
    output: json.read(row.output),
    toolCalls: json.read(row.toolCalls),
    durationMs: row.durationMs,
    tokenUsage: json.read(row.tokenUsage),
    error: row.error ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toToolCallRecord(
  row: ToolCallRow,
  json: JsonReader,
): ToolCallRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    input: json.read(row.input),
    output: json.read(row.output),
    durationMs: row.durationMs,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt,
  };
}

export function toStateSchemaRecord(
  row: StateSchemaRow,
  json: JsonReader,
): StateSchemaRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    schema: json.readRequired(row.schema),
    createdAt: row.createdAt,
  };
}

export function toStateEntryRecord(
  row: StateEntryRow,
  json: JsonReader,
): StateEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: json.read(row.value),
    updatedAt: row.updatedAt,
  };
}

export function toStateChangeRecord(
  row: StateChangeRow,
  json: JsonReader,
): StateChangeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    tableName: row.tableName,
    fieldName: row.fieldName,
    value: json.read(row.value),
    changedBy: row.changedBy,
    turnId: row.turnId,
    reason: row.reason ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toEventRecord(row: EventRow, json: JsonReader): EventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    topic: row.topic,
    payload: json.read(row.payload),
    targetRuntime: row.targetRuntime ?? undefined,
    turnId: row.turnId ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
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
  row: MessageRow,
  json: JsonReader,
): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    metadata: json.read(row.metadata),
    createdAt: row.createdAt,
  };
}

export function toCharacterRecord(
  row: CharacterRow,
  json: JsonReader,
): CharacterRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    type: row.type,
    description: row.description ?? undefined,
    fields: json.read(row.fields),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginDataRecord(
  row: PluginDataRow,
  json: JsonReader,
): PluginDataRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    namespace: row.namespace,
    key: row.key,
    value: json.read(row.value),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPluginConfigRecord(
  row: PluginConfigRow,
  json: JsonReader,
): PluginConfigRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    config: json.readRequired(row.config),
    updatedAt: row.updatedAt,
  };
}

export function toTraceEventRecord(
  row: TraceEventRow,
  json: JsonReader,
): TraceEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    traceId: row.traceId,
    turnId: row.turnId,
    payload: json.read(row.payload),
    createdAt: row.createdAt,
  };
}

export function toRuntimeOutputRecord(
  row: RuntimeOutputRow,
  json: JsonReader,
): RuntimeOutputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResultId: row.runtimeResultId ?? undefined,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    timestamp: row.timestamp,
    results: json.readRequired(row.results),
    metaData: json.readRequired(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toInteractionRecordRow(
  row: InteractionRow,
  json: JsonReader,
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
    payload: json.readRequired(row.payload),
    metaData: json.read(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toTurnMessageRecord(
  row: TurnMessageRow,
  json: JsonReader,
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
    ui: json.read(row.ui),
    pendingInput: json.read(row.pendingInput),
    order: row.order,
    createdAt: row.createdAt,
    compactedAtTurnId: row.compactedAtTurnId ?? undefined,
  };
}

export function toPlayerInputRecord(
  row: PlayerInputRow,
  json: JsonReader,
): PlayerInputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    formId: row.formId,
    values: json.readRequired(row.values),
    createdAt: row.createdAt,
  };
}

export function toWorkingMemoryRecord(
  row: WorkingMemoryRow,
  json: JsonReader,
): WorkingMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    key: row.key,
    scope: row.scope as WorkingMemoryRecord["scope"],
    value: json.readRequired(row.value),
    schemaRef: row.schemaRef ?? undefined,
    updatedAt: row.updatedAt,
  };
}

export function toWorldDataImportLedgerRecord(
  row: WorldDataLedgerRow,
  json: JsonReader,
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
        : ((json.readRequired(row.derivedFrom) as string[] | null) ?? []),
    importedAt: row.importedAt,
    managed: asBoolean(row.managed),
  };
}

export function toLorebookEntryRecord(
  row: LorebookEntryRow,
  json: JsonReader,
): LorebookEntryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    pluginId: row.pluginId,
    keys: ((json.readRequired(row.keys) as string[] | null) ??
      []) as readonly string[],
    content: row.content,
    strategy: row.strategy as LorebookEntryRecord["strategy"],
    position: row.position,
    insertionOrder: row.insertionOrder,
    enabled: asBoolean(row.enabled),
    extra: row.extra == null ? undefined : json.readRequired(row.extra),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSessionSummaryRecord(
  row: SessionSummaryRow,
  json: JsonReader,
): SessionSummaryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnRangeStart: row.turnRangeStart,
    turnRangeEnd: row.turnRangeEnd,
    content: row.content,
    focusSections:
      (json.readRequired(row.focusSections) as string[] | null) ?? [],
    createdAt: row.createdAt,
  };
}

export function toSnapshotRecord(
  row: SnapshotRow,
  json: JsonReader,
): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    kind: row.kind as SnapshotKind,
    parentId: row.parentId ?? undefined,
    payload: (json.readRequired(row.payload) ?? {}) as SnapshotPayload,
    createdAt: row.createdAt,
  };
}

export function toSuspensionRecord(
  row: SuspensionRow,
  json: JsonReader,
): SuspensionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeId: row.runtimeId,
    pluginId: row.pluginId,
    reason: row.reason,
    resumeSchema: json.readRequired(row.resumeSchema),
    pendingContinuation: (json.readRequired(row.pendingContinuation) ??
      {}) as SuspensionRecord["pendingContinuation"],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
