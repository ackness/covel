import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";

export function createSuspensionMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async saveSuspension(record) {
      state.suspensions.set(record.id, record);
    },

    async getSuspension(id) {
      return state.suspensions.get(id) ?? null;
    },

    async markSuspensionResolved(id) {
      const existing = state.suspensions.get(id);
      if (!existing) return;
      state.suspensions.set(id, {
        ...existing,
        resolvedAt: new Date().toISOString(),
      });
    },

    async claimSuspension(id) {
      const existing = state.suspensions.get(id);
      if (!existing) return false;
      if (existing.resolvedAt) return false;
      state.suspensions.set(id, {
        ...existing,
        resolvedAt: `claimed:${new Date().toISOString()}`,
      });
      return true;
    },

    async listSuspensions(sessionId) {
      return [...state.suspensions.values()].filter(
        (r) => r.sessionId === sessionId,
      );
    },

    async deleteSuspension(id) {
      state.suspensions.delete(id);
    },

    async deleteExpiredSuspensions(olderThanIso) {
      let deleted = 0;
      // Snapshot the entries before mutating the map.
      for (const [id, record] of [...state.suspensions.entries()]) {
        if (!record.resolvedAt && record.createdAt < olderThanIso) {
          state.suspensions.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

export function createSnapshotMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveSnapshot(record) {
      state.snapshots.set(record.id, structuredClone(record));
    },

    async getSnapshot(id) {
      const rec = state.snapshots.get(id);
      return rec ? structuredClone(rec) : null;
    },

    async listSnapshots(sessionId) {
      return [...state.snapshots.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => structuredClone(r));
    },

    async deleteSnapshot(id) {
      state.snapshots.delete(id);
    },
  };
}
