import type { LorebookOwner } from "@covel/shared";
import { lorebookOwnerKey } from "./lorebook-owner.js";
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
  toWorldDataImportLedgerRecord,
} from "./mappers.js";
import type { PluginDataRow } from "./mappers/plugin-mappers.js";
import type {
  LorebookEntryRow,
  WorldDataLedgerRow,
} from "./mappers/memory-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  DataStore,
  LorebookEntryRecord,
  PaginationOpts,
  PluginDataRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";

type PluginDataTable = Table & {
  sessionId: Column;
  pluginId: Column;
  namespace: Column;
  key: Column;
  updatedAt: Column;
  // Ordering keys for offset pagination — see the list methods below.
  createdAt: Column;
  id: Column;
};
type WorldDataLedgerTable = Table & {
  sessionId: Column;
  importedAt: Column;
  id: Column;
};
type LorebookEntriesTable = Table & {
  owner: Column;
  sessionId: Column;
  insertionOrder: Column;
  id: Column;
};

export interface SqlDataCrudTables {
  readonly pluginData: PluginDataTable;
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
  | "compareAndSetPluginData"
  | "getPluginData"
  | "listPluginData"
  | "listPluginDataSessionScope"
  | "deletePluginData"
  | "saveWorldDataImportLedgerBatch"
  | "listWorldDataImportLedger"
  | "deleteWorldDataImportLedger"
  | "upsertLorebookEntries"
  | "listSessionLorebookEntries"
  | "getLorebookEntry"
  | "deleteLorebookEntry"
>;

export function createSqlDataCrud(deps: SqlDataCrudDeps): SqlDataCrud {
  const { runner, tables, json, values } = deps;
  const { pluginData, worldDataImportLedger, lorebookEntries } = tables;

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

    async compareAndSetPluginData(
      record: PluginDataRecord,
      expectedUpdatedAt: string | null,
    ): Promise<boolean> {
      if (expectedUpdatedAt === null) {
        const inserted = await runner.insertIgnoreReturningCount(
          pluginData,
          values.pluginDataInsert(record),
          [
            pluginData.sessionId,
            pluginData.pluginId,
            pluginData.namespace,
            pluginData.key,
          ],
        );
        return inserted === 1;
      }

      const updated = await runner.updateReturningCount(
        pluginData,
        values.pluginDataUpdate(record),
        and(
          eq(pluginData.sessionId, record.sessionId),
          eq(pluginData.pluginId, record.pluginId),
          eq(pluginData.namespace, record.namespace),
          eq(pluginData.key, record.key),
          eq(pluginData.updatedAt, expectedUpdatedAt),
        ),
      );
      return updated === 1;
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
        // Offset pagination needs a total order the engine cannot perturb.
        // `createdAt` survives upsert (only value/updatedAt are rewritten) and
        // `id` breaks same-millisecond ties, so pages never skip or repeat.
        orderBy: [asc(pluginData.createdAt), asc(pluginData.id)],
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
        // Media GC pages through this to collect still-referenced asset ids;
        // without a stable total order PG may hand the same row twice or skip
        // it entirely, and a skipped row means live bytes get swept.
        orderBy: [asc(pluginData.createdAt), asc(pluginData.id)],
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
            target: [
              lorebookEntries.sessionId,
              lorebookEntries.owner,
              lorebookEntries.id,
            ],
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
        orderBy: [
          asc(lorebookEntries.insertionOrder),
          asc(lorebookEntries.id),
          asc(lorebookEntries.owner),
        ],
      });
      return rows.map((row) => toLorebookEntryRecord(row, json));
    },

    async getLorebookEntry(
      sessionId: string,
      owner: LorebookOwner,
      id: string,
    ) {
      const rows = await runner.select<LorebookEntryRow>(lorebookEntries, {
        where: and(
          eq(lorebookEntries.sessionId, sessionId),
          eq(lorebookEntries.owner, lorebookOwnerKey(owner)),
          eq(lorebookEntries.id, id),
        ),
        limit: 1,
      });
      return rows[0] ? toLorebookEntryRecord(rows[0], json) : null;
    },

    async deleteLorebookEntry(
      sessionId: string,
      owner: LorebookOwner,
      id: string,
    ): Promise<void> {
      await runner.delete(
        lorebookEntries,
        and(
          eq(lorebookEntries.sessionId, sessionId),
          eq(lorebookEntries.id, id),
          eq(lorebookEntries.owner, lorebookOwnerKey(owner)),
        ),
      );
    },
  };
}
