import type {
  SessionSummaryRecord,
  SnapshotRecord,
  SuspensionRecord,
  TurnMessageRecord,
} from "../types.js";
import type { IdbStoreContext, IdbStoreSlice } from "./idb-context.js";

export function createIdbPersistenceStore(ctx: IdbStoreContext): IdbStoreSlice {
  const { db, mutations } = ctx;

  return {
    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      await mutations.putAndTrack("sessionSummaries", structuredClone(record));
    },

    async listSessionSummaries(
      sessionId: string,
    ): Promise<readonly SessionSummaryRecord[]> {
      return db.getAllFromIndex("sessionSummaries", "sessionId", sessionId);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      const all = await db.getAllFromIndex(
        "sessionSummaries",
        "sessionId",
        sessionId,
      );
      for (const row of all) {
        await mutations.deleteAndTrack(
          "sessionSummaries",
          (row as SessionSummaryRecord).id,
        );
      }
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      const idSet = new Set(messageIds);
      const all = await db.getAllFromIndex(
        "turnMessages",
        "sessionId",
        sessionId,
      );
      for (const msg of all as TurnMessageRecord[]) {
        if (idSet.has(msg.id)) {
          await mutations.putAndTrack(
            "turnMessages",
            structuredClone({ ...msg, compactedAtTurnId: summaryId }),
          );
        }
      }
    },

    async saveSuspension(record: SuspensionRecord): Promise<void> {
      await mutations.putAndTrack("suspensions", structuredClone(record));
    },

    async getSuspension(id: string): Promise<SuspensionRecord | null> {
      return (await db.get("suspensions", id)) ?? null;
    },

    async markSuspensionResolved(id: string): Promise<void> {
      const existing = (await db.get("suspensions", id)) as
        | SuspensionRecord
        | undefined;
      if (!existing) return;
      await mutations.putAndTrack("suspensions", {
        ...existing,
        resolvedAt: new Date().toISOString(),
      });
    },

    async claimSuspension(id: string): Promise<boolean> {
      await mutations.ensureStoreSnapshot("suspensions");
      const tx = db.transaction("suspensions", "readwrite");
      const existing = (await tx.store.get(id)) as SuspensionRecord | undefined;
      if (!existing || existing.resolvedAt) {
        await tx.done;
        return false;
      }
      await tx.store.put(
        structuredClone({
          ...existing,
          resolvedAt: `claimed:${new Date().toISOString()}`,
        }),
      );
      await tx.done;
      return true;
    },

    async listSuspensions(
      sessionId: string,
    ): Promise<readonly SuspensionRecord[]> {
      const all = await db.getAllFromIndex(
        "suspensions",
        "sessionId",
        sessionId,
      );
      return (all as SuspensionRecord[]).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    },

    async deleteSuspension(id: string): Promise<void> {
      await mutations.deleteAndTrack("suspensions", id);
    },

    async deleteExpiredSuspensions(olderThanIso: string): Promise<number> {
      await mutations.ensureStoreSnapshot("suspensions");
      const all = (await db.getAll("suspensions")) as SuspensionRecord[];
      let deleted = 0;
      for (const record of all) {
        if (record.resolvedAt || record.createdAt >= olderThanIso) continue;
        // Re-read immediately before delete so a concurrent claimSuspension
        // (which sets resolvedAt to "claimed:<iso>") between the initial getAll
        // and now is never swept. SQL backends get this for free via the
        // DELETE … WHERE isNull(resolvedAt) re-evaluation; IDB deletes by key,
        // so the predicate must be re-checked here. (Best-effort — the residual
        // get→delete gap is negligible under browser local-mode's serial use;
        // a fully atomic read-check-delete would need a native IDB transaction.)
        const current = (await db.get("suspensions", record.id)) as
          | SuspensionRecord
          | undefined;
        if (
          !current ||
          current.resolvedAt ||
          current.createdAt >= olderThanIso
        ) {
          continue;
        }
        // deleteAndTrack keeps the sweep within the IDB tx-rollback model.
        await mutations.deleteAndTrack("suspensions", record.id);
        deleted += 1;
      }
      return deleted;
    },

    async saveSnapshot(record: SnapshotRecord): Promise<void> {
      await mutations.putAndTrack("state_snapshots", structuredClone(record));
    },

    async getSnapshot(id: string): Promise<SnapshotRecord | null> {
      return (
        ((await db.get("state_snapshots", id)) as SnapshotRecord | undefined) ??
        null
      );
    },

    async listSnapshots(sessionId: string): Promise<readonly SnapshotRecord[]> {
      const all = await db.getAllFromIndex(
        "state_snapshots",
        "sessionId",
        sessionId,
      );
      return (all as SnapshotRecord[]).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    },
  };
}
