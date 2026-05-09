import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
} from "./sqlite-store-mappers.js";
import {
  sqliteLorebookEntryInsert,
  sqliteLorebookEntryUpdate,
  sqlitePluginDataInsert,
  sqlitePluginDataUpdate,
  sqliteWorkingMemoryInsert,
  sqliteWorkingMemoryUpdate,
  sqliteWorldDataLedgerInsert,
  sqliteWorldDataLedgerUpdate,
} from "./sqlite-store-values.js";

type SqliteDb = BetterSQLite3Database<typeof schema>;

export type SqliteDataCrud = Pick<
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

export function createSqliteDataCrud(db: SqliteDb): SqliteDataCrud {
  return {
    async setPluginData(record: PluginDataRecord): Promise<void> {
      db.insert(schema.pluginData)
        .values(sqlitePluginDataInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.pluginData.sessionId,
            schema.pluginData.pluginId,
            schema.pluginData.namespace,
            schema.pluginData.key,
          ],
          set: sqlitePluginDataUpdate(record),
        })
        .run();
    },

    async setPluginDataBatch(
      records: readonly PluginDataRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      db.transaction((tx) => {
        for (const record of records) {
          tx.insert(schema.pluginData)
            .values(sqlitePluginDataInsert(record))
            .onConflictDoUpdate({
              target: [
                schema.pluginData.sessionId,
                schema.pluginData.pluginId,
                schema.pluginData.namespace,
                schema.pluginData.key,
              ],
              set: sqlitePluginDataUpdate(record),
            })
            .run();
        }
      });
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const row = db
        .select()
        .from(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        )
        .get();
      return row ? toPluginDataRecord(row) : null;
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

      let query = db
        .select()
        .from(schema.pluginData)
        .where(and(...conditions))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toPluginDataRecord);
    },

    async listPluginDataSessionScope(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<readonly PluginDataRecord[]> {
      // Uses the existing `plugin_data_session_id_idx` index for O(n) scan
      // scoped to one session (audit 2026-04-20 finding 7.2).
      let query = db
        .select()
        .from(schema.pluginData)
        .where(eq(schema.pluginData.sessionId, sessionId))
        .$dynamic();
      if (pagination?.limit !== undefined)
        query = query.limit(pagination.limit);
      if (pagination?.offset) query = query.offset(pagination.offset);
      return query.all().map(toPluginDataRecord);
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      db.delete(schema.pluginData)
        .where(
          and(
            eq(schema.pluginData.sessionId, sessionId),
            eq(schema.pluginData.pluginId, pluginId),
            eq(schema.pluginData.namespace, namespace),
            eq(schema.pluginData.key, key),
          ),
        )
        .run();
    },

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      db.insert(schema.workingMemory)
        .values(sqliteWorkingMemoryInsert(record))
        .onConflictDoUpdate({
          target: [
            schema.workingMemory.sessionId,
            schema.workingMemory.scope,
            schema.workingMemory.key,
          ],
          set: sqliteWorkingMemoryUpdate(record),
        })
        .run();
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const rows = db
        .select()
        .from(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        )
        .all();
      return rows.length > 0 ? toWorkingMemoryRecord(rows[0]) : null;
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const rows = db
        .select()
        .from(schema.workingMemory)
        .where(eq(schema.workingMemory.sessionId, sessionId))
        .orderBy(asc(schema.workingMemory.scope), asc(schema.workingMemory.key))
        .all();
      return rows.map(toWorkingMemoryRecord);
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      db.delete(schema.workingMemory)
        .where(
          and(
            eq(schema.workingMemory.sessionId, sessionId),
            eq(schema.workingMemory.scope, scope),
            eq(schema.workingMemory.key, key),
          ),
        )
        .run();
    },

    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      db.transaction((tx) => {
        for (const r of records) {
          tx.insert(schema.worldDataImportLedger)
            .values(sqliteWorldDataLedgerInsert(r))
            .onConflictDoUpdate({
              target: schema.worldDataImportLedger.id,
              set: sqliteWorldDataLedgerUpdate(r),
            })
            .run();
        }
      });
    },

    async listWorldDataImportLedger(
      sessionId: string,
    ): Promise<readonly WorldDataImportLedgerRecord[]> {
      const rows = db
        .select()
        .from(schema.worldDataImportLedger)
        .where(eq(schema.worldDataImportLedger.sessionId, sessionId))
        .orderBy(
          asc(schema.worldDataImportLedger.importedAt),
          asc(schema.worldDataImportLedger.id),
        )
        .all();
      return rows.map(toWorldDataImportLedgerRecord);
    },

    async deleteWorldDataImportLedger(
      sessionId: string,
      id: string,
    ): Promise<void> {
      db.delete(schema.worldDataImportLedger)
        .where(
          and(
            eq(schema.worldDataImportLedger.sessionId, sessionId),
            eq(schema.worldDataImportLedger.id, id),
          ),
        )
        .run();
    },

    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      // Drizzle's better-sqlite3 driver does not yet expose a multi-row
      // onConflictDoUpdate that updates per-row in one round trip, so we
      // upsert one row at a time inside an implicit BEGIN to keep it
      // atomic. Volumes are small (a handful of entries per world).
      for (const r of records) {
        db.insert(schema.lorebookEntries)
          .values(sqliteLorebookEntryInsert(r))
          .onConflictDoUpdate({
            target: schema.lorebookEntries.id,
            set: sqliteLorebookEntryUpdate(r),
          })
          .run();
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const rows = db
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.sessionId, sessionId))
        .orderBy(
          asc(schema.lorebookEntries.insertionOrder),
          asc(schema.lorebookEntries.id),
        )
        .all();
      return rows.map(toLorebookEntryRecord);
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      db.delete(schema.lorebookEntries)
        .where(
          and(
            eq(schema.lorebookEntries.sessionId, sessionId),
            eq(schema.lorebookEntries.id, id),
          ),
        )
        .run();
    },
  };
}
