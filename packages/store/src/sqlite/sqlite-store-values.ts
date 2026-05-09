import type {
  LorebookEntryRecord,
  PluginDataRecord,
  StateEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";
import * as schema from "./schema.js";
import { toJson } from "./sqlite-store-mappers.js";

type SqlitePluginDataInsert = typeof schema.pluginData.$inferInsert;
type SqliteStateEntryInsert = typeof schema.stateEntries.$inferInsert;
type SqliteWorkingMemoryInsert = typeof schema.workingMemory.$inferInsert;
type SqliteWorldDataLedgerInsert =
  typeof schema.worldDataImportLedger.$inferInsert;
type SqliteLorebookEntryInsert = typeof schema.lorebookEntries.$inferInsert;
type SqliteWorldInsert = typeof schema.worlds.$inferInsert;

export function sqlitePluginDataInsert(
  record: PluginDataRecord,
): SqlitePluginDataInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    namespace: record.namespace,
    key: record.key,
    value: toJson(record.value),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function sqlitePluginDataUpdate(
  record: PluginDataRecord,
): Partial<SqlitePluginDataInsert> {
  return {
    value: toJson(record.value),
    updatedAt: record.updatedAt,
  };
}

export function sqliteStateEntryInsert(
  record: StateEntryRecord,
): SqliteStateEntryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    tableName: record.tableName,
    fieldName: record.fieldName,
    value: toJson(record.value),
    updatedAt: record.updatedAt,
  };
}

export function sqliteStateEntryUpdate(
  record: StateEntryRecord,
): Partial<SqliteStateEntryInsert> {
  return {
    value: toJson(record.value),
    updatedAt: record.updatedAt,
  };
}

export function sqliteWorkingMemoryInsert(
  record: WorkingMemoryRecord,
): SqliteWorkingMemoryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    key: record.key,
    scope: record.scope,
    value: toJson(record.value),
    schemaRef: record.schemaRef ?? null,
    updatedAt: record.updatedAt,
  };
}

export function sqliteWorkingMemoryUpdate(
  record: WorkingMemoryRecord,
): Partial<SqliteWorkingMemoryInsert> {
  return {
    id: record.id,
    value: toJson(record.value),
    schemaRef: record.schemaRef ?? null,
    updatedAt: record.updatedAt,
  };
}

export function sqliteWorldDataLedgerInsert(
  record: WorldDataImportLedgerRecord,
): SqliteWorldDataLedgerInsert {
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
    derivedFrom:
      record.derivedFrom === undefined ? null : toJson(record.derivedFrom),
    importedAt: record.importedAt,
    managed: record.managed ? 1 : 0,
  };
}

export function sqliteWorldDataLedgerUpdate(
  record: WorldDataImportLedgerRecord,
): Partial<SqliteWorldDataLedgerInsert> {
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
    derivedFrom:
      record.derivedFrom === undefined ? null : toJson(record.derivedFrom),
    importedAt: record.importedAt,
    managed: record.managed ? 1 : 0,
  };
}

export function sqliteLorebookEntryInsert(
  record: LorebookEntryRecord,
): SqliteLorebookEntryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    keys: toJson(record.keys),
    content: record.content,
    strategy: record.strategy,
    position: record.position,
    insertionOrder: record.insertionOrder,
    enabled: record.enabled ? 1 : 0,
    extra: record.extra === undefined ? null : toJson(record.extra),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function sqliteLorebookEntryUpdate(
  record: LorebookEntryRecord,
): Partial<SqliteLorebookEntryInsert> {
  return {
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    keys: toJson(record.keys),
    content: record.content,
    strategy: record.strategy,
    position: record.position,
    insertionOrder: record.insertionOrder,
    enabled: record.enabled ? 1 : 0,
    extra: record.extra === undefined ? null : toJson(record.extra),
    updatedAt: record.updatedAt,
  };
}

export function sqliteWorldInsert(record: WorldRecord): SqliteWorldInsert {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    lore: record.lore ?? null,
    tags: record.tags != null ? toJson(record.tags) : null,
    locale: record.locale ?? null,
    metadata: record.metadata != null ? toJson(record.metadata) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? null,
  };
}

export function sqliteWorldUpdate(
  record: WorldRecord,
): Partial<SqliteWorldInsert> {
  return {
    name: record.name,
    description: record.description,
    lore: record.lore ?? null,
    tags: record.tags != null ? toJson(record.tags) : null,
    locale: record.locale ?? null,
    metadata: record.metadata != null ? toJson(record.metadata) : null,
    updatedAt: record.updatedAt ?? null,
  };
}
