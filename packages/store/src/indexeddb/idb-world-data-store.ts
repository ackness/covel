import type {
  LorebookEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";
import { compareWorkingMemoryEntries } from "../records/memory-records.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbWorldDataStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      const existing = await db.getFromIndex(
        "working_memory",
        "scopeKeyLookup",
        [record.sessionId, record.scope, record.key],
      );
      if (existing) {
        await mutations.deleteAndTrack("working_memory", existing.id);
      }
      await mutations.putAndTrack("working_memory", structuredClone(record));
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const result = await db.getFromIndex("working_memory", "scopeKeyLookup", [
        sessionId,
        scope,
        key,
      ]);
      return result ?? null;
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const entries = await db.getAllFromIndex(
        "working_memory",
        "sessionId",
        sessionId,
      );
      entries.sort(compareWorkingMemoryEntries);
      return entries;
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      const existing = await db.getFromIndex(
        "working_memory",
        "scopeKeyLookup",
        [sessionId, scope, key],
      );
      if (existing) {
        await mutations.deleteAndTrack("working_memory", existing.id);
      }
    },

    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await mutations.ensureStoreSnapshot("world_data_import_ledger");
      const tx = db.transaction("world_data_import_ledger", "readwrite");
      for (const record of records) {
        await tx.store.put(structuredClone(record));
      }
      await tx.done;
    },

    async listWorldDataImportLedger(
      sessionId: string,
    ): Promise<readonly WorldDataImportLedgerRecord[]> {
      const rows = (await db.getAllFromIndex(
        "world_data_import_ledger",
        "sessionId",
        sessionId,
      )) as WorldDataImportLedgerRecord[];
      return rows.sort((a, b) => {
        const timeDiff = a.importedAt.localeCompare(b.importedAt);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });
    },

    async deleteWorldDataImportLedger(
      sessionId: string,
      id: string,
    ): Promise<void> {
      const existing = (await db.get("world_data_import_ledger", id)) as
        | WorldDataImportLedgerRecord
        | undefined;
      if (existing?.sessionId === sessionId) {
        await mutations.deleteAndTrack("world_data_import_ledger", id);
      }
    },

    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      if (records.length === 0) return;
      await mutations.ensureStoreSnapshot("lorebook_entries");
      const tx = db.transaction("lorebook_entries", "readwrite");
      for (const record of records) {
        await tx.store.put(structuredClone(record));
      }
      await tx.done;
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const all = (await db.getAllFromIndex(
        "lorebook_entries",
        "sessionId",
        sessionId,
      )) as LorebookEntryRecord[];
      return all.slice().sort((a, b) => {
        if (a.insertionOrder !== b.insertionOrder) {
          return a.insertionOrder - b.insertionOrder;
        }
        return a.id.localeCompare(b.id);
      });
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      const existing = (await db.get("lorebook_entries", id)) as
        | LorebookEntryRecord
        | undefined;
      if (existing && existing.sessionId === sessionId) {
        await mutations.deleteAndTrack("lorebook_entries", id);
      }
    },
  };
}
