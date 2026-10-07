import type { LorebookOwner } from "@covel/shared";
import { lorebookOwnerKey } from "../common/lorebook-owner.js";
import { lorebookEntryKey } from "../common/keys.js";
import { compareByteOrder } from "../common/pagination.js";
import type {
  LorebookEntryRecord,
  WorldDataImportLedgerRecord,
} from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import { assertSessionRecordScope } from "./session-record-scope.js";

export function createWorldDataImportLedgerMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async saveWorldDataImportLedgerBatch(
      records: readonly WorldDataImportLedgerRecord[],
    ): Promise<void> {
      // Validate the entire batch before writing, including duplicate ids
      // within this batch, so a late conflict cannot leave partial changes.
      const pendingSessions = new Map<string, string>();
      for (const record of records) {
        assertSessionRecordScope(
          "world-data import ledger",
          record,
          pendingSessions.get(record.id) ??
            state.worldDataImportLedger.get(record.id)?.sessionId,
        );
        pendingSessions.set(record.id, record.sessionId);
      }
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
          return compareByteOrder(a.id, b.id);
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
          lorebookEntryKey(record.sessionId, record.owner, record.id),
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
        // Byte by byte, as the SQL backends order the two columns.
        return (
          compareByteOrder(a.id, b.id) ||
          compareByteOrder(lorebookOwnerKey(a.owner), lorebookOwnerKey(b.owner))
        );
      });
      return out;
    },

    async getLorebookEntry(
      sessionId: string,
      owner: LorebookOwner,
      id: string,
    ) {
      return (
        state.lorebookEntries.get(lorebookEntryKey(sessionId, owner, id)) ??
        null
      );
    },

    async deleteLorebookEntry(
      sessionId: string,
      owner: LorebookOwner,
      id: string,
    ): Promise<void> {
      state.lorebookEntries.delete(lorebookEntryKey(sessionId, owner, id));
    },
  };
}
