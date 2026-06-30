import { lorebookEntryKey, workingMemoryKey } from "../common/keys.js";
import { compareWorkingMemoryEntries } from "../records/memory-records.js";
import type {
  LorebookEntryRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createWorkingMemoryMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      const key = workingMemoryKey(record.sessionId, record.scope, record.key);
      state.workingMemoryEntries.set(key, record);
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      return (
        state.workingMemoryEntries.get(
          workingMemoryKey(sessionId, scope, key),
        ) ?? null
      );
    },

    async listWorkingMemory(
      sessionId: string,
    ): Promise<readonly WorkingMemoryRecord[]> {
      const entries = Array.from(state.workingMemoryEntries.values()).filter(
        (r) => r.sessionId === sessionId,
      );
      entries.sort(compareWorkingMemoryEntries);
      return entries;
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord["scope"],
      key: string,
    ): Promise<void> {
      state.workingMemoryEntries.delete(
        workingMemoryKey(sessionId, scope, key),
      );
    },
  };
}

export function createWorldDataImportLedgerMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      for (const record of records) {
        state.worldDataImportLedger.set(record.id, record);
      }
    },

    async listWorldDataImportLedger(
      sessionId: string,
    ): Promise<readonly WorldDataImportLedgerRecord[]> {
      return Array.from(state.worldDataImportLedger.values())
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => {
          const timeDiff = a.importedAt.localeCompare(b.importedAt);
          if (timeDiff !== 0) return timeDiff;
          return a.id.localeCompare(b.id);
        });
    },

    async deleteWorldDataImportLedger(
      sessionId: string,
      id: string,
    ): Promise<void> {
      const existing = state.worldDataImportLedger.get(id);
      if (existing?.sessionId === sessionId) {
        state.worldDataImportLedger.delete(id);
      }
    },
  };
}

export function createLorebookMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async upsertLorebookEntries(
      records: readonly LorebookEntryRecord[],
    ): Promise<void> {
      for (const record of records) {
        state.lorebookEntries.set(
          lorebookEntryKey(record.sessionId, record.id),
          record,
        );
      }
    },

    async listSessionLorebookEntries(
      sessionId: string,
    ): Promise<readonly LorebookEntryRecord[]> {
      const out = Array.from(state.lorebookEntries.values()).filter(
        (r) => r.sessionId === sessionId,
      );
      out.sort((a, b) => {
        if (a.insertionOrder !== b.insertionOrder) {
          return a.insertionOrder - b.insertionOrder;
        }
        return a.id.localeCompare(b.id);
      });
      return out;
    },

    async deleteLorebookEntry(sessionId: string, id: string): Promise<void> {
      state.lorebookEntries.delete(lorebookEntryKey(sessionId, id));
    },
  };
}
