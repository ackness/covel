/**
 * PostgreSQL insert/update value builders.
 *
 * The shared logic lives in `../common/insert-values.ts`; this module binds it
 * to the PostgreSQL serialization gateway ({@link pgJsonWriter}, which passes
 * JSON values through to `jsonb` columns) and re-exposes the historical
 * per-record function names with PG-specific `$inferInsert` return types.
 */

import { makeInsertValues } from "../common/insert-values.js";
import { pgJsonWriter } from "../common/json-writers.js";
import type {
  LorebookEntryRecord,
  PluginDataRecord,
  StateEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";
import type * as schema from "./schema.js";

type PgPluginDataInsert = typeof schema.pluginData.$inferInsert;
type PgStateEntryInsert = typeof schema.stateEntries.$inferInsert;
type PgWorkingMemoryInsert = typeof schema.workingMemory.$inferInsert;
type PgWorldDataLedgerInsert = typeof schema.worldDataImportLedger.$inferInsert;
type PgLorebookEntryInsert = typeof schema.lorebookEntries.$inferInsert;
type PgWorldInsert = typeof schema.worlds.$inferInsert;

const builders = makeInsertValues(pgJsonWriter);

export function pgPluginDataInsert(
  record: PluginDataRecord,
): PgPluginDataInsert {
  return builders.pluginDataInsert(record) as PgPluginDataInsert;
}

export function pgPluginDataUpdate(
  record: PluginDataRecord,
): Partial<PgPluginDataInsert> {
  return builders.pluginDataUpdate(record) as Partial<PgPluginDataInsert>;
}

export function pgStateEntryInsert(
  record: StateEntryRecord,
): PgStateEntryInsert {
  return builders.stateEntryInsert(record) as PgStateEntryInsert;
}

export function pgStateEntryUpdate(
  record: StateEntryRecord,
): Partial<PgStateEntryInsert> {
  return builders.stateEntryUpdate(record) as Partial<PgStateEntryInsert>;
}

export function pgWorkingMemoryInsert(
  record: WorkingMemoryRecord,
): PgWorkingMemoryInsert {
  return builders.workingMemoryInsert(record) as PgWorkingMemoryInsert;
}

export function pgWorkingMemoryUpdate(
  record: WorkingMemoryRecord,
): Partial<PgWorkingMemoryInsert> {
  return builders.workingMemoryUpdate(record) as Partial<PgWorkingMemoryInsert>;
}

export function pgWorldDataLedgerInsert(
  record: WorldDataImportLedgerRecord,
): PgWorldDataLedgerInsert {
  return builders.worldDataLedgerInsert(record) as PgWorldDataLedgerInsert;
}

export function pgWorldDataLedgerUpdate(
  record: WorldDataImportLedgerRecord,
): Partial<PgWorldDataLedgerInsert> {
  return builders.worldDataLedgerUpdate(
    record,
  ) as Partial<PgWorldDataLedgerInsert>;
}

export function pgLorebookEntryInsert(
  record: LorebookEntryRecord,
): PgLorebookEntryInsert {
  return builders.lorebookEntryInsert(record) as PgLorebookEntryInsert;
}

export function pgLorebookEntryUpdate(
  record: LorebookEntryRecord,
): Partial<PgLorebookEntryInsert> {
  return builders.lorebookEntryUpdate(record) as Partial<PgLorebookEntryInsert>;
}

export function pgWorldInsert(record: WorldRecord): PgWorldInsert {
  return builders.worldInsert(record) as PgWorldInsert;
}

export function pgWorldUpdate(record: WorldRecord): Partial<PgWorldInsert> {
  return builders.worldUpdate(record) as Partial<PgWorldInsert>;
}
