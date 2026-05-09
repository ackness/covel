import type {
  LorebookEntryRecord,
  PluginDataRecord,
  StateEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";
import * as schema from "./schema.js";

type PgPluginDataInsert = typeof schema.pluginData.$inferInsert;
type PgStateEntryInsert = typeof schema.stateEntries.$inferInsert;
type PgWorkingMemoryInsert = typeof schema.workingMemory.$inferInsert;
type PgWorldDataLedgerInsert = typeof schema.worldDataImportLedger.$inferInsert;
type PgLorebookEntryInsert = typeof schema.lorebookEntries.$inferInsert;
type PgWorldInsert = typeof schema.worlds.$inferInsert;

export function pgPluginDataInsert(
  record: PluginDataRecord,
): PgPluginDataInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    namespace: record.namespace,
    key: record.key,
    value: record.value ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function pgPluginDataUpdate(
  record: PluginDataRecord,
): Partial<PgPluginDataInsert> {
  return {
    value: record.value ?? null,
    updatedAt: record.updatedAt,
  };
}

export function pgStateEntryInsert(
  record: StateEntryRecord,
): PgStateEntryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    tableName: record.tableName,
    fieldName: record.fieldName,
    value: record.value ?? null,
    updatedAt: record.updatedAt,
  };
}

export function pgStateEntryUpdate(
  record: StateEntryRecord,
): Partial<PgStateEntryInsert> {
  return {
    value: record.value ?? null,
    updatedAt: record.updatedAt,
  };
}

export function pgWorkingMemoryInsert(
  record: WorkingMemoryRecord,
): PgWorkingMemoryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    key: record.key,
    scope: record.scope,
    value: record.value ?? null,
    schemaRef: record.schemaRef ?? null,
    updatedAt: record.updatedAt,
  };
}

export function pgWorkingMemoryUpdate(
  record: WorkingMemoryRecord,
): Partial<PgWorkingMemoryInsert> {
  return {
    id: record.id,
    value: record.value ?? null,
    schemaRef: record.schemaRef ?? null,
    updatedAt: record.updatedAt,
  };
}

export function pgWorldDataLedgerInsert(
  record: WorldDataImportLedgerRecord,
): PgWorldDataLedgerInsert {
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
    derivedFrom: (record.derivedFrom ?? null) as unknown,
    importedAt: record.importedAt,
    managed: record.managed ? 1 : 0,
  };
}

export function pgWorldDataLedgerUpdate(
  record: WorldDataImportLedgerRecord,
): Partial<PgWorldDataLedgerInsert> {
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
    derivedFrom: (record.derivedFrom ?? null) as unknown,
    importedAt: record.importedAt,
    managed: record.managed ? 1 : 0,
  };
}

export function pgLorebookEntryInsert(
  record: LorebookEntryRecord,
): PgLorebookEntryInsert {
  return {
    id: record.id,
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    keys: record.keys as unknown as string[],
    content: record.content,
    strategy: record.strategy,
    position: record.position,
    insertionOrder: record.insertionOrder,
    enabled: record.enabled ? 1 : 0,
    extra: (record.extra ?? null) as unknown,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function pgLorebookEntryUpdate(
  record: LorebookEntryRecord,
): Partial<PgLorebookEntryInsert> {
  return {
    sessionId: record.sessionId,
    pluginId: record.pluginId,
    keys: record.keys as unknown as string[],
    content: record.content,
    strategy: record.strategy,
    position: record.position,
    insertionOrder: record.insertionOrder,
    enabled: record.enabled ? 1 : 0,
    extra: (record.extra ?? null) as unknown,
    updatedAt: record.updatedAt,
  };
}

export function pgWorldInsert(record: WorldRecord): PgWorldInsert {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    lore: record.lore ?? null,
    tags: record.tags ?? null,
    locale: record.locale ?? null,
    metadata: record.metadata ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? null,
  };
}

export function pgWorldUpdate(record: WorldRecord): Partial<PgWorldInsert> {
  return {
    name: record.name,
    description: record.description,
    lore: record.lore ?? null,
    tags: record.tags ?? null,
    locale: record.locale ?? null,
    metadata: record.metadata ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}
