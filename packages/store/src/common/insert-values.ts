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
  LorebookEntryRecord,
  PluginDataRecord,
  StateEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";

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
  };
}
