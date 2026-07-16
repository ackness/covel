import { applyCursorPage, sortByCursorAsc } from "../common/pagination.js";
import type { SnapshotMetadata } from "../types.js";
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
      // Sort by createdAt to match SQL (asc(suspensions.createdAt)) and IDB;
      // Map insertion order would otherwise diverge on out-of-order inserts.
      return [...state.suspensions.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

    async listSnapshotsPage(sessionId, opts) {
      // JS mirror of the SQL keyset page: sort by `(createdAt, id)` then slice
      // the window. Metadata only — `size` is the serialized payload length,
      // matching the SQL `length(cast(payload as text))` char count.
      const ascending = sortByCursorAsc(
        [...state.snapshots.values()].filter((r) => r.sessionId === sessionId),
      );
      const page = applyCursorPage(ascending, opts);
      return page.map(
        (r): SnapshotMetadata => ({
          id: r.id,
          sessionId: r.sessionId,
          turnId: r.turnId,
          kind: r.kind,
          ...(r.parentId != null ? { parentId: r.parentId } : {}),
          createdAt: r.createdAt,
          size: JSON.stringify(r.payload).length,
        }),
      );
    },
  };
}
