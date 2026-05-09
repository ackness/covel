import { and, asc, eq } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import type {
  DataStore,
  LorebookEntryRecord,
  PaginationOpts,
  PluginDataRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";
import * as schema from "./schema.js";
import {
  toLorebookEntryRecord,
  toPluginDataRecord,
  toWorkingMemoryRecord,
  toWorldDataImportLedgerRecord,
} from "./pg-store-mappers.js";
import {
  pgLorebookEntryInsert,
  pgLorebookEntryUpdate,
  pgPluginDataInsert,
  pgPluginDataUpdate,
  pgWorkingMemoryInsert,
  pgWorkingMemoryUpdate,
  pgWorldDataLedgerInsert,
  pgWorldDataLedgerUpdate,
} from "./pg-store-values.js";

type PgDb =
  | PostgresJsDatabase<typeof schema>
  | PostgresJsTransaction<
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export type PgDataCrud = Pick<
  DataStore,
  | "setPluginData"
  | "setPluginDataBatch"
  | "getPluginData"
  | "listPluginData"
  | "listPluginDataSessionScope"
  | "deletePluginData"
  | "upsertWorkingMemory"
  | "getWorkingMemory"
  | "listWorkingMemory"
  | "deleteWorkingMemory"
  | "saveWorldDataImportLedgerBatch"
  | "listWorldDataImportLedger"
  | "deleteWorldDataImportLedger"
  | "upsertLorebookEntries"
  | "listSessionLorebookEntries"
  | "deleteLorebookEntry"
>;

export function createPgDataCrud(getDb: () => PgDb): PgDataCrud {
  return {
    async setPluginData(record: PluginDataRecord): Promise<void> {
      await getDb()
        .insert(schema.pluginData)
        .values(pgPluginDataInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.pluginData.sessionId,
            schema.pluginData.pluginId,
            schema.pluginData.namespace,
            schema.pluginData.key,
          ],
          set: pgPluginDataUpdate(record),
        });
    },

    async setPluginDataBatch(
      records: readonly PluginDataRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await getDb().transaction(async (tx) => {
        for (const record of records) {
          await tx
            .insert(schema.pluginData)
            .values(pgPluginDataInsert(record))
            .onConflictDoUpdate({
              target: [
                schema.pluginData.sessionId,
                schema.pluginData.pluginId,
                schema.pluginData.namespace,
                schema.pluginData.key,
              ],
              set: pgPluginDataUpdate(record),
            });
        }
      });
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        );
      return rows.length > 0 ? toPluginDataRecord(rows[0]) : null;
    },

    async listPluginData(
      sessionId: string,
      pluginId: string,
      namespace?: string,
      pagination?: PaginationOpts,
    ): Promise<PluginDataRecord[]> {
      const conditions = [
        eq(schema.pluginData.sessionId, sessionId),
        eq(schema.pluginData.pluginId, pluginId),
      ];
      if (namespace != null) {
        conditions.push(eq(schema.pluginData.namespace, namespace));
      }

      let query = getDb()
        .select()
        .from(schema.pluginData)
        .where(and(...conditions))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toPluginDataRecord);
    },

    async listPluginDataSessionScope(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<readonly PluginDataRecord[]> {
      // Full session scope — used by the snapshot payload builder to avoid
      // missing plugins that never produced a runtime result (audit
      // 2026-04-20 finding 7.2).
      let query = getDb()
        .select()
        .from(schema.pluginData)
        .where(eq(schema.pluginData.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      const rows = await query;
      return rows.map(toPluginDataRecord);
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      await getDb()
        .delete(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        );
    },

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      await getDb()
        .insert(schema.workingMemory)
        .values(pgWorkingMemoryInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.workingMemory.sessionId,
            schema.workingMemory.scope,
            schema.workingMemory.key,
          ],
          set: pgWorkingMemoryUpdate(record),
        });
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const rows = await getDb()
        .select()
        .from(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        );
      return rows.length > 0 ? toWorkingMemoryRecord(rows[0]) : null;
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.workingMemory)
        .where(eq(schema.workingMemory.sessionId, sessionId))
        .orderBy(
          asc(schema.workingMemory.scope),
          asc(schema.workingMemory.key),
        );
      return rows.map(toWorkingMemoryRecord);
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      await getDb()
        .delete(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        );
    },

    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await getDb().transaction(async (tx) => {
        for (const r of records) {
          await tx
            .insert(schema.worldDataImportLedger)
            .values(pgWorldDataLedgerInsert(r))
            .onConflictDoUpdate({
              target: schema.worldDataImportLedger.id,
              set: pgWorldDataLedgerUpdate(r),
            });
        }
      });
    },

    async listWorldDataImportLedger(
      sessionId: string,
    ): Promise<readonly WorldDataImportLedgerRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.worldDataImportLedger)
        .where(eq(schema.worldDataImportLedger.sessionId, sessionId))
        .orderBy(
          asc(schema.worldDataImportLedger.importedAt),
          asc(schema.worldDataImportLedger.id),
        );
      return rows.map(toWorldDataImportLedgerRecord);
    },

    async deleteWorldDataImportLedger(
      sessionId: string,
      id: string,
    ): Promise<void> {
      await getDb()
        .delete(schema.worldDataImportLedger)
        .where(
          and(
            eq(schema.worldDataImportLedger.sessionId, sessionId),
            eq(schema.worldDataImportLedger.id, id),
          ),
        );
    },

    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      for (const r of records) {
        await getDb()
          .insert(schema.lorebookEntries)
          .values(pgLorebookEntryInsert(r))
          .onConflictDoUpdate({
            target: schema.lorebookEntries.id,
            set: pgLorebookEntryUpdate(r),
          });
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const rows = await getDb()
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.sessionId, sessionId))
        .orderBy(
          asc(schema.lorebookEntries.insertionOrder),
          asc(schema.lorebookEntries.id),
        );
      return rows.map(toLorebookEntryRecord);
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      await getDb()
        .delete(schema.lorebookEntries)
        .where(
          and(
            eq(schema.lorebookEntries.sessionId, sessionId),
            eq(schema.lorebookEntries.id, id),
          ),
        );
    },
  };
}
