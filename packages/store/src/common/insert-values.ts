/**
 * Backend-agnostic insert/update value builders.
 *
 * The PostgreSQL and SQLite backends build identical drizzle insert/update
 * payloads; the ONLY difference is how JSON columns are serialized:
 *
 *  - PostgreSQL `jsonb` columns receive the raw JS value.
 *  - SQLite `text` columns receive a JSON string.
 *
 * {@link makeInsertValues} returns a set of builders parameterized by a
 * {@link JsonWriter} so the per-backend modules only supply that thin
 * serialization gateway. The shapes returned structurally satisfy each
 * backend's drizzle `$inferInsert` type.
 */

import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
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

/**
 * The mutable subset of {@link SessionRecord} accepted by `updateSession`.
 * Mirrors `DataStore["updateSession"]`'s patch parameter.
 */
export type SessionUpdatePatch = Partial<
  Pick<
    SessionRecord,
    | "status"
    | "turnCount"
    | "preGameCompleted"
    | "activePlugins"
    | "presetId"
    | "locale"
    | "updatedAt"
    | "metadata"
    | "embeddingModelId"
    | "embeddingLockedAt"
    | "runtimeModelOverrides"
  >
>;

/**
 * Per-backend JSON serialization gateway injected into the value builders.
 */
export interface JsonWriter {
  /**
   * Encode a JSON value column. The value is always serialized — PG passes it
   * through (`value ?? null`), SQLite stringifies it (`toJson(value)`, which
   * turns `null`/`undefined` into the string `"null"`).
   */
  writeJson(value: unknown): unknown;
  /**
   * Encode a nullable JSON column. `null`/`undefined` stays `null`; otherwise
   * the value is encoded — PG passes it through, SQLite stringifies it.
   */
  writeNullableJson(value: unknown): unknown;
}

export interface InsertValueBuilders {
  pluginDataInsert(record: PluginDataRecord): Record<string, unknown>;
  pluginDataUpdate(record: PluginDataRecord): Record<string, unknown>;
  stateEntryInsert(record: StateEntryRecord): Record<string, unknown>;
  stateEntryUpdate(record: StateEntryRecord): Record<string, unknown>;
  stateSchemaInsert(record: StateSchemaRecord): Record<string, unknown>;
  stateSchemaUpdate(record: StateSchemaRecord): Record<string, unknown>;
  stateChangeInsert(record: StateChangeRecord): Record<string, unknown>;
  turnResultInsert(record: TurnResultRecord): Record<string, unknown>;
  runtimeResultInsert(record: RuntimeResultRecord): Record<string, unknown>;
  toolCallInsert(record: ToolCallRecordRow): Record<string, unknown>;
  runtimeOutputInsert(record: RuntimeOutputRecord): Record<string, unknown>;
  interactionRecordInsert(
    record: InteractionRecordRow,
  ): Record<string, unknown>;
  workingMemoryInsert(record: WorkingMemoryRecord): Record<string, unknown>;
  workingMemoryUpdate(record: WorkingMemoryRecord): Record<string, unknown>;
  worldDataLedgerInsert(
    record: WorldDataImportLedgerRecord,
  ): Record<string, unknown>;
  worldDataLedgerUpdate(
    record: WorldDataImportLedgerRecord,
  ): Record<string, unknown>;
  lorebookEntryInsert(record: LorebookEntryRecord): Record<string, unknown>;
  lorebookEntryUpdate(record: LorebookEntryRecord): Record<string, unknown>;
  worldInsert(record: WorldRecord): Record<string, unknown>;
  worldUpdate(record: WorldRecord): Record<string, unknown>;
  eventInsert(record: EventRecord): Record<string, unknown>;
  approvalInsert(record: ApprovalRecord): Record<string, unknown>;
  messageInsert(record: MessageRecord): Record<string, unknown>;
  characterInsert(record: CharacterRecord): Record<string, unknown>;
  characterUpdate(record: CharacterRecord): Record<string, unknown>;
  traceEventInsert(record: TraceEventRecord): Record<string, unknown>;
  playerInputInsert(record: PlayerInputRecord): Record<string, unknown>;
  sessionSummaryInsert(record: SessionSummaryRecord): Record<string, unknown>;
  turnMessageInsert(record: TurnMessageRecord): Record<string, unknown>;
  sessionInsert(record: SessionRecord): Record<string, unknown>;
  sessionUpdate(
    patch: SessionUpdatePatch,
    merged: SessionRecord,
  ): Record<string, unknown>;
  snapshotInsert(record: SnapshotRecord): Record<string, unknown>;
  snapshotUpdate(record: SnapshotRecord): Record<string, unknown>;
  suspensionInsert(record: SuspensionRecord): Record<string, unknown>;
  suspensionUpdate(record: SuspensionRecord): Record<string, unknown>;
}

export function makeInsertValues(json: JsonWriter): InsertValueBuilders {
  return {
    pluginDataInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        pluginId: record.pluginId,
        namespace: record.namespace,
        key: record.key,
        value: json.writeJson(record.value),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
    pluginDataUpdate(record) {
      return {
        value: json.writeJson(record.value),
        updatedAt: record.updatedAt,
      };
    },

    stateEntryInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        tableName: record.tableName,
        fieldName: record.fieldName,
        value: json.writeJson(record.value),
        updatedAt: record.updatedAt,
      };
    },
    stateEntryUpdate(record) {
      return {
        value: json.writeJson(record.value),
        updatedAt: record.updatedAt,
      };
    },

    stateSchemaInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        tableName: record.tableName,
        schema: json.writeJson(record.schema),
        createdAt: record.createdAt,
      };
    },
    stateSchemaUpdate(record) {
      return {
        schema: json.writeJson(record.schema),
      };
    },

    stateChangeInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        tableName: record.tableName,
        fieldName: record.fieldName,
        value: json.writeJson(record.value),
        changedBy: record.changedBy,
        turnId: record.turnId,
        reason: record.reason ?? null,
        createdAt: record.createdAt,
      };
    },

    // ── Runtime-domain tables (no upsert; plain inserts) ──────────
    // The JSON column nullability below mirrors the legacy inline builders
    // exactly: `writeJson` columns are always serialized (PG `value ?? null`,
    // SQLite `toJson`), `writeNullableJson` columns keep SQL NULL when absent.

    turnResultInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        runtimeResults: json.writeJson(record.runtimeResults),
        conflicts: json.writeNullableJson(record.conflicts),
        auditResult: json.writeNullableJson(record.auditResult),
        origin: record.origin ?? null,
        parentTurnId: record.parentTurnId ?? null,
        durationMs: record.durationMs,
        createdAt: record.createdAt,
      };
    },

    runtimeResultInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        status: record.status,
        output: json.writeNullableJson(record.output),
        toolCalls: json.writeNullableJson(record.toolCalls),
        durationMs: record.durationMs,
        tokenUsage: json.writeNullableJson(record.tokenUsage),
        error: record.error ?? null,
        createdAt: record.createdAt,
      };
    },

    toolCallInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        toolName: record.toolName,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        input: json.writeNullableJson(record.input),
        output: json.writeNullableJson(record.output),
        durationMs: record.durationMs,
        approvalStatus: record.approvalStatus,
        createdAt: record.createdAt,
      };
    },

    runtimeOutputInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        runtimeResultId: record.runtimeResultId ?? null,
        pluginId: record.pluginId,
        runtimeId: record.runtimeId,
        timestamp: record.timestamp,
        results: json.writeJson(record.results ?? []),
        metaData: json.writeJson(record.metaData ?? {}),
        createdAt: record.createdAt,
      };
    },

    interactionRecordInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId ?? null,
        timestamp: record.timestamp,
        source: record.source,
        channel: record.channel,
        type: record.type,
        targetPluginId: record.targetPluginId ?? null,
        targetRuntimeId: record.targetRuntimeId ?? null,
        payload: json.writeJson(record.payload ?? null),
        metaData: json.writeNullableJson(record.metaData),
        createdAt: record.createdAt,
      };
    },

    workingMemoryInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        key: record.key,
        scope: record.scope,
        value: json.writeJson(record.value),
        schemaRef: record.schemaRef ?? null,
        updatedAt: record.updatedAt,
      };
    },
    workingMemoryUpdate(record) {
      return {
        id: record.id,
        value: json.writeJson(record.value),
        schemaRef: record.schemaRef ?? null,
        updatedAt: record.updatedAt,
      };
    },

    worldDataLedgerInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        target: record.target,
        pluginId: record.pluginId ?? null,
        namespace: record.namespace ?? null,
        key: record.key ?? null,
        sourceWorldId: record.sourceWorldId,
        sourceId: record.sourceId,
        sourceDigest: record.sourceDigest,
        valueHash: record.valueHash,
        schemaRef: record.schemaRef ?? null,
        derivedFrom: json.writeNullableJson(record.derivedFrom),
        importedAt: record.importedAt,
        managed: record.managed ? 1 : 0,
      };
    },
    worldDataLedgerUpdate(record) {
      return {
        sessionId: record.sessionId,
        target: record.target,
        pluginId: record.pluginId ?? null,
        namespace: record.namespace ?? null,
        key: record.key ?? null,
        sourceWorldId: record.sourceWorldId,
        sourceId: record.sourceId,
        sourceDigest: record.sourceDigest,
        valueHash: record.valueHash,
        schemaRef: record.schemaRef ?? null,
        derivedFrom: json.writeNullableJson(record.derivedFrom),
        importedAt: record.importedAt,
        managed: record.managed ? 1 : 0,
      };
    },

    lorebookEntryInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        pluginId: record.pluginId,
        keys: json.writeJson(record.keys),
        content: record.content,
        strategy: record.strategy,
        position: record.position,
        insertionOrder: record.insertionOrder,
        enabled: record.enabled ? 1 : 0,
        extra: json.writeNullableJson(record.extra),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
    lorebookEntryUpdate(record) {
      return {
        sessionId: record.sessionId,
        pluginId: record.pluginId,
        keys: json.writeJson(record.keys),
        content: record.content,
        strategy: record.strategy,
        position: record.position,
        insertionOrder: record.insertionOrder,
        enabled: record.enabled ? 1 : 0,
        extra: json.writeNullableJson(record.extra),
        updatedAt: record.updatedAt,
      };
    },

    worldInsert(record) {
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        lore: record.lore ?? null,
        tags: json.writeNullableJson(record.tags),
        locale: record.locale ?? null,
        metadata: json.writeNullableJson(record.metadata),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? null,
      };
    },
    worldUpdate(record) {
      return {
        name: record.name,
        description: record.description,
        lore: record.lore ?? null,
        tags: json.writeNullableJson(record.tags),
        locale: record.locale ?? null,
        metadata: json.writeNullableJson(record.metadata),
        updatedAt: record.updatedAt ?? null,
      };
    },

    // ── Session content/journal tables ────────────────────────────
    // JSON column nullability mirrors the legacy inline builders exactly:
    //  - `payload`/`metadata`/`fields` were `?? null` (PG) / `!= null ? toJson
    //    : null` (SQLite) → `writeNullableJson`.
    //  - `config`/`values`/`focusSections` were `?? null` (PG) / `toJson`
    //    (SQLite, no null-guard) → `writeJson`.

    eventInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        topic: record.topic,
        payload: json.writeNullableJson(record.payload),
        targetRuntime: record.targetRuntime ?? null,
        turnId: record.turnId ?? null,
        createdAt: record.createdAt,
      };
    },

    approvalInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        toolName: record.toolName,
        pluginId: record.pluginId,
        decision: record.decision,
        turnId: record.turnId,
        createdAt: record.createdAt,
      };
    },

    messageInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        role: record.role,
        content: record.content,
        metadata: json.writeNullableJson(record.metadata),
        createdAt: record.createdAt,
      };
    },

    characterInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        name: record.name,
        type: record.type,
        description: record.description ?? null,
        fields: json.writeNullableJson(record.fields),
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },
    characterUpdate(record) {
      return {
        name: record.name,
        type: record.type,
        description: record.description ?? null,
        fields: json.writeNullableJson(record.fields),
        version: record.version,
        updatedAt: record.updatedAt,
      };
    },

    traceEventInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        traceId: record.traceId,
        turnId: record.turnId,
        payload: json.writeNullableJson(record.payload),
        createdAt: record.createdAt,
      };
    },

    playerInputInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        formId: record.formId,
        values: json.writeJson(record.values),
        createdAt: record.createdAt,
      };
    },

    sessionSummaryInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnRangeStart: record.turnRangeStart,
        turnRangeEnd: record.turnRangeEnd,
        content: record.content,
        focusSections: json.writeJson(record.focusSections),
        createdAt: record.createdAt,
      };
    },

    // ── Turn messages ─────────────────────────────────────────────
    // `ui`/`pendingInput` are nullable JSON (PG passthrough / SQLite toJson with
    // a null-guard) → `writeNullableJson`. `compactedAtTurnId` is persisted on
    // every backend (the legacy SQLite insert omitted it — a data-loss bug).

    turnMessageInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        sourceType: record.sourceType,
        sourcePluginId: record.sourcePluginId ?? null,
        sourceRuntimeId: record.sourceRuntimeId ?? null,
        role: record.role,
        name: record.name ?? null,
        content: record.content,
        ui: json.writeNullableJson(record.ui),
        pendingInput: json.writeNullableJson(record.pendingInput),
        order: record.order,
        createdAt: record.createdAt,
        compactedAtTurnId: record.compactedAtTurnId ?? null,
      };
    },

    // ── Sessions ──────────────────────────────────────────────────
    // `preGameCompleted`/`activePlugins` are required JSON arrays → `writeJson`
    // (no `?? []`/`?? {}` coercion — the field is always present). `metadata`
    // and `runtimeModelOverrides` are optional → `writeNullableJson`, so an
    // absent override map is stored as SQL NULL on every backend rather than an
    // empty-object literal.

    sessionInsert(record) {
      return {
        id: record.id,
        worldId: record.worldId ?? null,
        status: record.status,
        turnCount: record.turnCount,
        preGameCompleted: json.writeJson(record.preGameCompleted),
        locale: record.locale,
        activePlugins: json.writeJson(record.activePlugins),
        metadata: json.writeNullableJson(record.metadata),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        runtimeModelOverrides: json.writeNullableJson(
          record.runtimeModelOverrides,
        ),
      };
    },

    sessionUpdate(patch, merged) {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.turnCount !== undefined) values.turnCount = patch.turnCount;
      if (patch.preGameCompleted !== undefined) {
        values.preGameCompleted = json.writeJson(patch.preGameCompleted);
      }
      if (patch.activePlugins !== undefined) {
        values.activePlugins = json.writeJson(patch.activePlugins);
      }
      if ("metadata" in patch || "presetId" in patch) {
        values.metadata = json.writeNullableJson(merged.metadata);
      }
      if (patch.locale !== undefined) values.locale = patch.locale;
      if (patch.updatedAt !== undefined) values.updatedAt = patch.updatedAt;
      if ("embeddingModelId" in patch) {
        values.embeddingModelId = patch.embeddingModelId ?? null;
      }
      if ("embeddingLockedAt" in patch) {
        values.embeddingLockedAt = patch.embeddingLockedAt ?? null;
      }
      if ("runtimeModelOverrides" in patch) {
        values.runtimeModelOverrides = json.writeNullableJson(
          patch.runtimeModelOverrides,
        );
      }
      return values;
    },

    // ── Snapshots / Suspensions ───────────────────────────────────
    // `payload`/`resumeSchema`/`pendingContinuation` are required (`notNull`)
    // JSON columns → `writeJson` (PG passthrough / SQLite `toJson`), matching the
    // legacy raw-SQL `toJson(...)` (SQLite) and direct passthrough (PG). The
    // upsert builders return ONLY the ON CONFLICT DO UPDATE SET column set:
    //  - snapshots: {turnId, kind, parentId, payload} (not id/sessionId/createdAt)
    //  - suspensions: {reason, resumeSchema, pendingContinuation, resolvedAt}
    // `parentId`/`resolvedAt` keep their `?? null` coercion (plain text columns).

    snapshotInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        kind: record.kind,
        parentId: record.parentId ?? null,
        payload: json.writeJson(record.payload),
        createdAt: record.createdAt,
      };
    },
    snapshotUpdate(record) {
      return {
        turnId: record.turnId,
        kind: record.kind,
        parentId: record.parentId ?? null,
        payload: json.writeJson(record.payload),
      };
    },

    suspensionInsert(record) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        turnId: record.turnId,
        runtimeId: record.runtimeId,
        pluginId: record.pluginId,
        reason: record.reason,
        resumeSchema: json.writeJson(record.resumeSchema),
        pendingContinuation: json.writeJson(record.pendingContinuation),
        createdAt: record.createdAt,
        resolvedAt: record.resolvedAt ?? null,
      };
    },
    suspensionUpdate(record) {
      return {
        reason: record.reason,
        resumeSchema: json.writeJson(record.resumeSchema),
        pendingContinuation: json.writeJson(record.pendingContinuation),
        resolvedAt: record.resolvedAt ?? null,
      };
    },
  };
}
