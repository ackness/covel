/**
 * SQLite insert/update value builders.
 *
 * The shared logic lives in `../common/insert-values.ts`; this module binds it
 * to the SQLite serialization gateway ({@link sqliteJsonWriter}, which encodes
 * JSON columns as text) and re-exposes the historical per-record function
 * names with SQLite-specific `$inferInsert` return types.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { sqliteJsonWriter } from "../common/json-writers.js";
import type {
  LorebookEntryRecord,
  PluginDataRecord,
  StateEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";
import type * as schema from "./schema.js";

type SqlitePluginDataInsert = typeof schema.pluginData.$inferInsert;
type SqliteStateEntryInsert = typeof schema.stateEntries.$inferInsert;
type SqliteWorkingMemoryInsert = typeof schema.workingMemory.$inferInsert;
type SqliteWorldDataLedgerInsert =
  typeof schema.worldDataImportLedger.$inferInsert;
type SqliteLorebookEntryInsert = typeof schema.lorebookEntries.$inferInsert;
type SqliteWorldInsert = typeof schema.worlds.$inferInsert;

const builders = makeInsertValues(sqliteJsonWriter);

export function sqlitePluginDataInsert(
  record: PluginDataRecord,
): SqlitePluginDataInsert {
  return builders.pluginDataInsert(record) as SqlitePluginDataInsert;
}

export function sqlitePluginDataUpdate(
  record: PluginDataRecord,
): Partial<SqlitePluginDataInsert> {
  return builders.pluginDataUpdate(record) as Partial<SqlitePluginDataInsert>;
}

export function sqliteStateEntryInsert(
  record: StateEntryRecord,
): SqliteStateEntryInsert {
  return builders.stateEntryInsert(record) as SqliteStateEntryInsert;
}

export function sqliteStateEntryUpdate(
  record: StateEntryRecord,
): Partial<SqliteStateEntryInsert> {
  return builders.stateEntryUpdate(record) as Partial<SqliteStateEntryInsert>;
}

export function sqliteWorkingMemoryInsert(
  record: WorkingMemoryRecord,
): SqliteWorkingMemoryInsert {
  return builders.workingMemoryInsert(record) as SqliteWorkingMemoryInsert;
}

export function sqliteWorkingMemoryUpdate(
  record: WorkingMemoryRecord,
): Partial<SqliteWorkingMemoryInsert> {
  return builders.workingMemoryUpdate(
    record,
  ) as Partial<SqliteWorkingMemoryInsert>;
}

export function sqliteWorldDataLedgerInsert(
  record: WorldDataImportLedgerRecord,
): SqliteWorldDataLedgerInsert {
  return builders.worldDataLedgerInsert(record) as SqliteWorldDataLedgerInsert;
}

export function sqliteWorldDataLedgerUpdate(
  record: WorldDataImportLedgerRecord,
): Partial<SqliteWorldDataLedgerInsert> {
  return builders.worldDataLedgerUpdate(
    record,
  ) as Partial<SqliteWorldDataLedgerInsert>;
}

export function sqliteLorebookEntryInsert(
  record: LorebookEntryRecord,
): SqliteLorebookEntryInsert {
  return builders.lorebookEntryInsert(record) as SqliteLorebookEntryInsert;
}

export function sqliteLorebookEntryUpdate(
  record: LorebookEntryRecord,
): Partial<SqliteLorebookEntryInsert> {
  return builders.lorebookEntryUpdate(
    record,
  ) as Partial<SqliteLorebookEntryInsert>;
}

export function sqliteWorldInsert(record: WorldRecord): SqliteWorldInsert {
  return builders.worldInsert(record) as SqliteWorldInsert;
}

export function sqliteWorldUpdate(
  record: WorldRecord,
): Partial<SqliteWorldInsert> {
  return builders.worldUpdate(record) as Partial<SqliteWorldInsert>;
}
