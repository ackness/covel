import { compareText } from "@covel/shared";
import { applyCursorPage, sortByCursorAsc } from "../common/pagination.js";
import { settledSuspensionContinuation } from "../records/snapshot-records.js";
import type { SnapshotMetadata } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import { assertSessionRecordScope } from "./session-record-scope.js";
import { requireSnapshotPayload } from "../common/mappers/snapshot-mappers.js";

export function createSuspensionMethods(
  state: MemoryState,
): MemoryStoreMethods {
  return {
    async saveSuspension(record) {
      assertSessionRecordScope(
        "suspension",
        record,
        state.suspensions.get(record.id)?.sessionId,
      );
      // Like the SQL update: only the reason, resume schema, continuation
      // and resolution of an existing suspension change.
      const existing = state.suspensions.get(record.id);
      state.suspensions.set(
        record.id,
        existing
          ? {
              ...record,
              turnId: existing.turnId,
              runtimeId: existing.runtimeId,
              pluginId: existing.pluginId,
              createdAt: existing.createdAt,
            }
          : record,
      );
    },

    async getSuspension(id) {
      return state.suspensions.get(id) ?? null;
    },

    async markSuspensionResolved(id) {
      const existing = state.suspensions.get(id);
      if (!existing) return;
      state.suspensions.set(id, {
        ...existing,
        pendingContinuation: settledSuspensionContinuation(
          existing.pendingContinuation,
        ),
        resolvedAt: new Date().toISOString(),
      });
    },

    async claimSuspension(id) {
      const existing = state.suspensions.get(id);
      if (!existing) return null;
      if (existing.resolvedAt) return null;
      const claim = `claimed:${new Date().toISOString()}`;
      state.suspensions.set(id, { ...existing, resolvedAt: claim });
      return claim;
    },

    async releaseSuspensionClaim(id, claim) {
      const existing = state.suspensions.get(id);
      if (!existing || existing.resolvedAt !== claim) return false;
      const { resolvedAt: _claim, ...unclaimed } = existing;
      state.suspensions.set(id, unclaimed);
      return true;
    },

    async listSuspensions(sessionId) {
      // Sort by createdAt to match SQL (asc(suspensions.createdAt)) and IDB;
      // Map insertion order would otherwise diverge on out-of-order inserts.
      return [...state.suspensions.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => compareText(a.createdAt, b.createdAt));
    },

    async deleteSuspension(id) {
      state.suspensions.delete(id);
    },

    async deleteExpiredSuspensions(olderThanIso) {
      let deleted = 0;
      // Deleting the current entry while iterating a Map is safe.
      for (const [id, record] of state.suspensions.entries()) {
        if (!record.resolvedAt && record.createdAt < olderThanIso) {
          state.suspensions.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },

    async releaseStaleSuspensionClaims(olderThanIso) {
      let released = 0;
      for (const [id, record] of state.suspensions.entries()) {
        const claim = record.resolvedAt;
        if (
          claim?.startsWith("claimed:") &&
          claim < `claimed:${olderThanIso}`
        ) {
          const { resolvedAt: _claim, ...unclaimed } = record;
          state.suspensions.set(id, unclaimed);
          released += 1;
        }
      }
      return released;
    },
  };
}

export function createSnapshotMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveSnapshot(record) {
      requireSnapshotPayload(record.payload);
      assertSessionRecordScope(
        "snapshot",
        record,
        state.snapshots.get(record.id)?.sessionId,
      );
      state.snapshots.set(record.id, structuredClone(record));
    },

    async getSnapshot(id) {
      const rec = state.snapshots.get(id);
      return rec ? structuredClone(rec) : null;
    },

    async listSnapshots(sessionId) {
      return [...state.snapshots.values()]
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => compareText(a.createdAt, b.createdAt))
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
      return page.map((r): SnapshotMetadata => ({
        id: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId,
        kind: r.kind,
        ...(r.parentId != null ? { parentId: r.parentId } : {}),
        createdAt: r.createdAt,
        size: JSON.stringify(r.payload).length,
      }));
    },

    async pruneAutoSnapshots(sessionId, keep) {
      const autos = sortByCursorAsc(
        [...state.snapshots.values()].filter(
          (r) => r.sessionId === sessionId && r.kind === "auto",
        ),
      );
      const candidates = autos.slice(0, Math.max(0, autos.length - keep));
      if (candidates.length === 0) return 0;
      const parents = new Set(
        [...state.snapshots.values()].flatMap((r) =>
          r.parentId != null ? [r.parentId] : [],
        ),
      );
      let deleted = 0;
      for (const candidate of candidates) {
        if (parents.has(candidate.id)) continue;
        state.snapshots.delete(candidate.id);
        deleted++;
      }
      return deleted;
    },
  };
}
