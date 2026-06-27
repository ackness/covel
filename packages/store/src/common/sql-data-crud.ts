/**
 * Backend-agnostic plugin-data / working-memory / world-data-ledger / lorebook
 * queries, shared by the PostgreSQL and SQLite backends.
 *
 * Previously `postgres/pg-data-crud.ts` and `sqlite/sqlite-data-crud.ts` were
 * line-for-line mirrors differing only in the sync/async terminal and the JSON
 * serialization. Both differences are injected here — the {@link SqlRunner}
 * abstracts the terminal, the {@link JsonReader} the read gateway, and the
 * value builders ({@link InsertValueBuilders}) the write gateway — so this is
 * the single source of truth for the data-CRUD surface.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toLorebookEntryRecord,
  toPluginDataRecord,
  toWorkingMemoryRecord,
  toWorldDataImportLedgerRecord,
} from "./mappers.js";
import type { PluginDataRow } from "./mappers/plugin-mappers.js";
import type {
  LorebookEntryRow,
  WorkingMemoryRow,
  WorldDataLedgerRow,
} from "./mappers/memory-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  LorebookEntryRecord,
  PaginationOpts,
  PluginDataRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";

type PluginDataTable = Table & {
  sessionId: Column;
  pluginId: Column;
  namespace: Column;
  key: Column;
};
type WorkingMemoryTable = Table & {
  sessionId: Column;
  scope: Column;
  key: Column;
};
type WorldDataLedgerTable = Table & {
  sessionId: Column;
  importedAt: Column;
  id: Column;
};
type LorebookEntriesTable = Table & {
  sessionId: Column;
  insertionOrder: Column;
  id: Column;
};

export interface SqlDataCrudTables {
  readonly pluginData: PluginDataTable;
  readonly workingMemory: WorkingMemoryTable;
  readonly worldDataImportLedger: WorldDataLedgerTable;
  readonly lorebookEntries: LorebookEntriesTable;
}

export interface SqlDataCrudDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlDataCrudTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "pluginDataInsert"
    | "pluginDataUpdate"
    | "workingMemoryInsert"
    | "workingMemoryUpdate"
    | "worldDataLedgerInsert"
    | "worldDataLedgerUpdate"
    | "lorebookEntryInsert"
    | "lorebookEntryUpdate"
  >;
}

export type SqlDataCrud = Pick<
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

export function createSqlDataCrud(deps: SqlDataCrudDeps): SqlDataCrud {
  const { runner, tables, json, values } = deps;
  const { pluginData, workingMemory, worldDataImportLedger, lorebookEntries } =
    tables;

  return {
    async setPluginData(record: PluginDataRecord): Promise<void> {
      await runner.insert(pluginData, values.pluginDataInsert(record), {
        target: [
          pluginData.sessionId,
          pluginData.pluginId,
          pluginData.namespace,
          pluginData.key,
        ],
        set: values.pluginDataUpdate(record),
      });
    },

    async setPluginDataBatch(
      records: readonly PluginDataRecord[],
    ): Promise<void> {
      const target = [
        pluginData.sessionId,
        pluginData.pluginId,
        pluginData.namespace,
        pluginData.key,
      ];
      await runner.insertManyAtomic(
        pluginData,
        records.map((record) => ({
          values: values.pluginDataInsert(record),
          conflict: { target, set: values.pluginDataUpdate(record) },
        })),
      );
    },

    async getPluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<PluginDataRecord | null> {
      const row = await runner.selectFirst<PluginDataRow>(pluginData, {
        where: and(
          eq(pluginData.sessionId, sessionId),
          eq(pluginData.pluginId, pluginId),
          eq(pluginData.namespace, namespace),
          eq(pluginData.key, key),
        ),
      });
      return row ? toPluginDataRecord(row, json) : null;
    },

    async listPluginData(
      sessionId: string,
      pluginId: string,
      namespace?: string,
      pagination?: PaginationOpts,
    ): Promise<PluginDataRecord[]> {
      const conditions = [
        eq(pluginData.sessionId, sessionId),
        eq(pluginData.pluginId, pluginId),
      ];
      if (namespace != null) {
        conditions.push(eq(pluginData.namespace, namespace));
      }
      const rows = await runner.select<PluginDataRow>(pluginData, {
        where: and(...conditions),
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toPluginDataRecord(row, json));
    },

    async listPluginDataSessionScope(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<readonly PluginDataRecord[]> {
      // Full session scope — used by the snapshot payload builder to avoid
      // missing plugins that never produced a runtime result (audit
      // 2026-04-20 finding 7.2). Scoped to one session via the
      // `plugin_data_session_id_idx` index.
      const rows = await runner.select<PluginDataRow>(pluginData, {
        where: eq(pluginData.sessionId, sessionId),
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toPluginDataRecord(row, json));
    },

    async deletePluginData(
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ): Promise<void> {
      await runner.delete(
        pluginData,
        and(
          eq(pluginData.sessionId, sessionId),
          eq(pluginData.pluginId, pluginId),
          eq(pluginData.namespace, namespace),
          eq(pluginData.key, key),
        ),
      );
    },

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      await runner.insert(workingMemory, values.workingMemoryInsert(record), {
        target: [
          workingMemory.sessionId,
          workingMemory.scope,
          workingMemory.key,
        ],
        set: values.workingMemoryUpdate(record),
      });
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const row = await runner.selectFirst<WorkingMemoryRow>(workingMemory, {
        where: and(
          eq(workingMemory.sessionId, sessionId),
          eq(workingMemory.scope, scope),
          eq(workingMemory.key, key),
        ),
      });
      return row ? toWorkingMemoryRecord(row, json) : null;
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const rows = await runner.select<WorkingMemoryRow>(workingMemory, {
        where: eq(workingMemory.sessionId, sessionId),
        orderBy: [asc(workingMemory.scope), asc(workingMemory.key)],
      });
      return rows.map((row) => toWorkingMemoryRecord(row, json));
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      await runner.delete(
        workingMemory,
        and(
          eq(workingMemory.sessionId, sessionId),
          eq(workingMemory.scope, scope),
          eq(workingMemory.key, key),
        ),
      );
    },

    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      await runner.insertManyAtomic(
        worldDataImportLedger,
        records.map((record) => ({
          values: values.worldDataLedgerInsert(record),
          conflict: {
            target: worldDataImportLedger.id,
            set: values.worldDataLedgerUpdate(record),
          },
        })),
      );
    },

    async listWorldDataImportLedger(
      sessionId: string,
    ): Promise<readonly WorldDataImportLedgerRecord[]> {
      const rows = await runner.select<WorldDataLedgerRow>(
        worldDataImportLedger,
        {
          where: eq(worldDataImportLedger.sessionId, sessionId),
          orderBy: [
            asc(worldDataImportLedger.importedAt),
            asc(worldDataImportLedger.id),
          ],
        },
      );
      return rows.map((row) => toWorldDataImportLedgerRecord(row, json));
    },

    async deleteWorldDataImportLedger(
      sessionId: string,
      id: string,
    ): Promise<void> {
      await runner.delete(
        worldDataImportLedger,
        and(
          eq(worldDataImportLedger.sessionId, sessionId),
          eq(worldDataImportLedger.id, id),
        ),
      );
    },

    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      // Per-entry upsert without a wrapping transaction — matching the legacy
      // backends, which both looped one row at a time (PG without an explicit
      // tx, SQLite relying on per-statement commits). Volumes are tiny (a
      // handful of entries per world).
      for (const record of records) {
        await runner.insert(
          lorebookEntries,
          values.lorebookEntryInsert(record),
          {
            target: lorebookEntries.id,
            set: values.lorebookEntryUpdate(record),
          },
        );
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const rows = await runner.select<LorebookEntryRow>(lorebookEntries, {
        where: eq(lorebookEntries.sessionId, sessionId),
        orderBy: [asc(lorebookEntries.insertionOrder), asc(lorebookEntries.id)],
      });
      return rows.map((row) => toLorebookEntryRecord(row, json));
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      await runner.delete(
        lorebookEntries,
        and(
          eq(lorebookEntries.sessionId, sessionId),
          eq(lorebookEntries.id, id),
        ),
      );
    },
  };
}
