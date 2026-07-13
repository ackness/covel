import { beforeEach, describe, expect, it } from "vitest";
import type {
  CharacterRecord,
  DataStore,
  SnapshotPayloadV2,
  StateEntryRecord,
} from "../../types.js";
import {
  id,
  makeApproval,
  makeCharacter,
  makeEvent,
  makeInteractionRecord,
  makeLorebookEntry,
  makeMessage,
  makePlayerInput,
  makeRuntimeOutput,
  makeRuntimeResult,
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeSnapshotPayload,
  makeSnapshotPayloadV2,
  makeStateChange,
  makeStateEntry,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
  makeWorkingMemory,
  makeWorld,
  makeWorldDataImportLedger,
  ts,
} from "../test-fixtures.js";

export function registerPersistenceStoreSuites(
  getStore: () => DataStore,
): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("Suspensions (S4-T4)", () => {
    it("should save and retrieve a suspension (roundtrip)", async () => {
      const suspension = makeSuspension({ sessionId: "sess-susp-1" });
      await store.saveSuspension(suspension);
      const result = await store.getSuspension(suspension.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(suspension.id);
      expect(result!.sessionId).toBe("sess-susp-1");
      expect(result!.reason).toBe(suspension.reason);
      expect(result!.resolvedAt).toBeUndefined();
    });

    it("should filter listSuspensions by sessionId", async () => {
      const s1 = makeSuspension({ sessionId: "sess-susp-A" });
      const s2 = makeSuspension({ sessionId: "sess-susp-A" });
      const s3 = makeSuspension({ sessionId: "sess-susp-B" });
      await store.saveSuspension(s1);
      await store.saveSuspension(s2);
      await store.saveSuspension(s3);

      const listA = await store.listSuspensions("sess-susp-A");
      expect(listA).toHaveLength(2);
      expect(listA.map((s) => s.id)).toContain(s1.id);
      expect(listA.map((s) => s.id)).toContain(s2.id);

      const listB = await store.listSuspensions("sess-susp-B");
      expect(listB).toHaveLength(1);
      expect(listB[0].id).toBe(s3.id);
    });

    it("parity: listSuspensions returns entries sorted by createdAt", async () => {
      // Insert out of createdAt order; every backend must return ascending
      // createdAt (SQL/IDB sort; MemoryStore previously returned insertion order).
      const later = makeSuspension({
        sessionId: "sess-susp-ord",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const earlier = makeSuspension({
        sessionId: "sess-susp-ord",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await store.saveSuspension(later);
      await store.saveSuspension(earlier);

      const list = await store.listSuspensions("sess-susp-ord");
      expect(list.map((s) => s.id)).toEqual([earlier.id, later.id]);
    });

    it("should markSuspensionResolved — sets resolvedAt, leaves other fields intact", async () => {
      const suspension = makeSuspension({ sessionId: "sess-susp-res" });
      await store.saveSuspension(suspension);
      await store.markSuspensionResolved(suspension.id);

      const result = await store.getSuspension(suspension.id);
      expect(result).not.toBeNull();
      expect(result!.resolvedAt).not.toBeUndefined();
      // Other fields unchanged
      expect(result!.reason).toBe(suspension.reason);
      expect(result!.runtimeId).toBe(suspension.runtimeId);
    });

    it("should deleteSuspension — removes only the targeted record", async () => {
      const s1 = makeSuspension({ sessionId: "sess-susp-del" });
      const s2 = makeSuspension({ sessionId: "sess-susp-del" });
      await store.saveSuspension(s1);
      await store.saveSuspension(s2);

      await store.deleteSuspension(s1.id);

      const r1 = await store.getSuspension(s1.id);
      const r2 = await store.getSuspension(s2.id);
      expect(r1).toBeNull();
      expect(r2).not.toBeNull();
    });

    it("should return null for non-existent suspension ID", async () => {
      const result = await store.getSuspension("nonexistent-id");
      expect(result).toBeNull();
    });

    it("should persist complex resumeSchema JSON", async () => {
      const complexSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      };
      const suspension = makeSuspension({
        sessionId: "sess-susp-schema",
        resumeSchema: complexSchema,
      });
      await store.saveSuspension(suspension);

      const result = await store.getSuspension(suspension.id);
      expect(result!.resumeSchema).toEqual(complexSchema);
    });

    // ── deleteExpiredSuspensions (S4-T4.c TTL sweep) ──────────────
    // A global maintenance sweep: deletes ONLY records that are still
    // unresolved (resolvedAt unset) AND older than the supplied cutoff.
    // Claimed (in-flight, `claimed:<iso>`) and successfully-resolved
    // records must never be touched. Must behave identically on every
    // backend (store-backend-parity rule).
    describe("deleteExpiredSuspensions (S4-T4.c TTL sweep)", () => {
      const CUTOFF = "2025-06-01T00:00:00.000Z";
      const OLD = "2020-01-01T00:00:00.000Z";
      const FRESH = "2099-01-01T00:00:00.000Z";

      it("deletes unresolved suspensions older than the cutoff", async () => {
        const old = makeSuspension({ sessionId: "sess-ttl", createdAt: OLD });
        await store.saveSuspension(old);

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(1);
        expect(await store.getSuspension(old.id)).toBeNull();
      });

      it("keeps unresolved suspensions newer than the cutoff", async () => {
        const fresh = makeSuspension({
          sessionId: "sess-ttl",
          createdAt: FRESH,
        });
        await store.saveSuspension(fresh);

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(0);
        expect(await store.getSuspension(fresh.id)).not.toBeNull();
      });

      it("never deletes claimed (in-flight) suspensions even when old", async () => {
        const old = makeSuspension({ sessionId: "sess-ttl", createdAt: OLD });
        await store.saveSuspension(old);
        expect(await store.claimSuspension(old.id)).toBe(true);

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(0);
        expect(await store.getSuspension(old.id)).not.toBeNull();
      });

      it("never deletes successfully-resolved suspensions even when old", async () => {
        const old = makeSuspension({ sessionId: "sess-ttl", createdAt: OLD });
        await store.saveSuspension(old);
        await store.markSuspensionResolved(old.id);

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(0);
        expect(await store.getSuspension(old.id)).not.toBeNull();
      });

      it("returns the exact number of records deleted", async () => {
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl", createdAt: OLD }),
        );
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl", createdAt: OLD }),
        );
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl", createdAt: FRESH }),
        );

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(2);
      });

      it("is a no-op returning 0 when nothing is expired", async () => {
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl", createdAt: FRESH }),
        );

        expect(await store.deleteExpiredSuspensions(CUTOFF)).toBe(0);
      });

      it("sweeps globally across sessions in one call", async () => {
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl-A", createdAt: OLD }),
        );
        await store.saveSuspension(
          makeSuspension({ sessionId: "sess-ttl-B", createdAt: OLD }),
        );

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(2);
        expect(await store.listSuspensions("sess-ttl-A")).toHaveLength(0);
        expect(await store.listSuspensions("sess-ttl-B")).toHaveLength(0);
      });
    });
  });

  describe("LorebookEntries (S3-T2)", () => {
    it("returns an empty list when the session has no entries", async () => {
      const result = await store.listSessionLorebookEntries("sess-lore-empty");
      expect(result).toEqual([]);
    });

    it("upserts a batch and lists them sorted by insertionOrder then id", async () => {
      const a = makeLorebookEntry({
        id: "lore-a",
        sessionId: "sess-lore-1",
        insertionOrder: 200,
        content: "second",
      });
      const b = makeLorebookEntry({
        id: "lore-b",
        sessionId: "sess-lore-1",
        insertionOrder: 100,
        content: "first",
        keys: ["ancient", "temple"],
        strategy: "selective",
        enabled: true,
      });
      const c = makeLorebookEntry({
        id: "lore-c",
        sessionId: "sess-lore-1",
        insertionOrder: 200,
        content: "third",
        enabled: false,
        extra: { atDepth: 4, note: "kept disabled for now" },
      });

      await store.upsertLorebookEntries([a, b, c]);

      const list = await store.listSessionLorebookEntries("sess-lore-1");
      expect(list.map((r) => r.id)).toEqual(["lore-b", "lore-a", "lore-c"]);
      expect(list[0].keys).toEqual(["ancient", "temple"]);
      expect(list[0].strategy).toBe("selective");
      expect(list[2].enabled).toBe(false);
      expect(list[2].extra).toEqual({
        atDepth: 4,
        note: "kept disabled for now",
      });
    });

    it("replaces existing entries on re-upsert with the same id", async () => {
      const original = makeLorebookEntry({
        id: "lore-update",
        sessionId: "sess-lore-2",
        content: "original",
        insertionOrder: 300,
      });
      await store.upsertLorebookEntries([original]);

      const updated = {
        ...original,
        content: "updated",
        insertionOrder: 50,
        updatedAt: ts(1),
      };
      await store.upsertLorebookEntries([updated]);

      const list = await store.listSessionLorebookEntries("sess-lore-2");
      expect(list).toHaveLength(1);
      expect(list[0].content).toBe("updated");
      expect(list[0].insertionOrder).toBe(50);
    });

    it("isolates entries by sessionId", async () => {
      await store.upsertLorebookEntries([
        makeLorebookEntry({ id: "lore-x", sessionId: "sess-lore-A" }),
        makeLorebookEntry({ id: "lore-y", sessionId: "sess-lore-B" }),
      ]);

      const a = await store.listSessionLorebookEntries("sess-lore-A");
      const b = await store.listSessionLorebookEntries("sess-lore-B");
      expect(a.map((r) => r.id)).toEqual(["lore-x"]);
      expect(b.map((r) => r.id)).toEqual(["lore-y"]);
    });

    it("deleteLorebookEntry removes a single entry by sessionId+id", async () => {
      await store.upsertLorebookEntries([
        makeLorebookEntry({ id: "lore-keep", sessionId: "sess-lore-del" }),
        makeLorebookEntry({ id: "lore-drop", sessionId: "sess-lore-del" }),
      ]);

      await store.deleteLorebookEntry("sess-lore-del", "lore-drop");
      const list = await store.listSessionLorebookEntries("sess-lore-del");
      expect(list.map((r) => r.id)).toEqual(["lore-keep"]);
    });
  });

  describe("Snapshots (S4-T2)", () => {
    it("should save and retrieve a snapshot (roundtrip)", async () => {
      const snap = makeSnapshot({ sessionId: "sess-snap-1", kind: "manual" });
      await store.saveSnapshot(snap);
      const result = await store.getSnapshot(snap.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(snap.id);
      expect(result!.sessionId).toBe("sess-snap-1");
      expect(result!.kind).toBe("manual");
      expect(result!.turnId).toBe(snap.turnId);
    });

    it("should return null for non-existent snapshot ID", async () => {
      const result = await store.getSnapshot("nonexistent-snapshot");
      expect(result).toBeNull();
    });

    it("should filter listSnapshots by sessionId and sort by createdAt", async () => {
      const s1 = makeSnapshot({ sessionId: "sess-snap-A", createdAt: ts(0) });
      const s2 = makeSnapshot({
        sessionId: "sess-snap-A",
        createdAt: ts(1000),
      });
      const s3 = makeSnapshot({ sessionId: "sess-snap-B" });
      await store.saveSnapshot(s1);
      await store.saveSnapshot(s2);
      await store.saveSnapshot(s3);

      const listA = await store.listSnapshots("sess-snap-A");
      expect(listA).toHaveLength(2);
      expect(listA[0].id).toBe(s1.id);
      expect(listA[1].id).toBe(s2.id);

      const listB = await store.listSnapshots("sess-snap-B");
      expect(listB).toHaveLength(1);
      expect(listB[0].id).toBe(s3.id);
    });

    it("should persist all payload slices verbatim", async () => {
      const payload = makeSnapshotPayload({
        characters: [
          {
            id: "char-1",
            sessionId: "sess-snap-pay",
            name: "Hero",
            type: "player",
            version: 1,
            createdAt: ts(),
            updatedAt: ts(),
          },
        ],
        stateEntries: [
          {
            id: "se-1",
            sessionId: "sess-snap-pay",
            tableName: "stats",
            fieldName: "hp",
            value: 100,
            updatedAt: ts(),
          },
        ],
        pluginData: [
          {
            id: "pd-1",
            sessionId: "sess-snap-pay",
            pluginId: "test-plugin",
            namespace: "ns",
            key: "k",
            value: { a: 1 },
            createdAt: ts(),
            updatedAt: ts(),
          },
        ],
        workingMemory: [
          {
            id: "wm-1",
            sessionId: "sess-snap-pay",
            key: "mood",
            scope: "player",
            value: "curious",
            updatedAt: ts(),
          },
        ],
        messagesCursor: "tm-last-abc",
      });
      const snap = makeSnapshot({ sessionId: "sess-snap-pay", payload });
      await store.saveSnapshot(snap);

      const result = await store.getSnapshot(snap.id);
      expect(result).not.toBeNull();
      expect(result!.payload.characters).toHaveLength(1);
      expect(result!.payload.characters[0].name).toBe("Hero");
      expect(result!.payload.stateEntries[0].value).toBe(100);
      expect(result!.payload.pluginData[0].value).toEqual({ a: 1 });
      expect(result!.payload.workingMemory[0].scope).toBe("player");
      expect(result!.payload.messagesCursor).toBe("tm-last-abc");
    });

    it("should round-trip a V2 payload's session lifecycle state", async () => {
      const payload = makeSnapshotPayloadV2();
      const snap = makeSnapshot({ sessionId: "sess-snap-v2", payload });
      await store.saveSnapshot(snap);

      const result = (await store.getSnapshot(snap.id))!
        .payload as SnapshotPayloadV2;
      expect(result.schemaVersion).toBe(2);
      expect(result.session).toEqual(payload.session);
    });

    it("should keep optional V2 session fields absent after round-trip", async () => {
      // presetId / runtimeModelOverrides are optional — JSON serialisation
      // must not resurrect them as null (store-backend parity contract).
      const payload = makeSnapshotPayloadV2({
        session: {
          status: "paused",
          turnCount: 0,
          preGameCompleted: [],
          locale: "en-US",
          activePlugins: [],
        },
      });
      const snap = makeSnapshot({ sessionId: "sess-snap-v2", payload });
      await store.saveSnapshot(snap);

      const result = (await store.getSnapshot(snap.id))!
        .payload as SnapshotPayloadV2;
      expect(result.session.presetId).toBeUndefined();
      expect(result.session.runtimeModelOverrides).toBeUndefined();
      expect(result.session.status).toBe("paused");
    });

    it('should record parentId for kind="fork" snapshots', async () => {
      const origin = makeSnapshot({
        sessionId: "sess-snap-origin",
        kind: "auto",
      });
      await store.saveSnapshot(origin);

      const forkChild = makeSnapshot({
        sessionId: "sess-snap-fork-child",
        kind: "fork",
        parentId: origin.id,
      });
      await store.saveSnapshot(forkChild);

      const result = await store.getSnapshot(forkChild.id);
      expect(result!.kind).toBe("fork");
      expect(result!.parentId).toBe(origin.id);
    });
  });

  describe("claimSuspension", () => {
    it("returns true on first claim and atomically sets resolvedAt", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-ok" });
      await store.saveSuspension(suspension);

      const firstClaim = await store.claimSuspension(suspension.id);
      expect(firstClaim).toBe(true);

      const afterClaim = await store.getSuspension(suspension.id);
      expect(afterClaim).not.toBeNull();
      expect(afterClaim!.resolvedAt).toBeTruthy();
    });

    it("returns false on a subsequent claim (already claimed)", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-conflict" });
      await store.saveSuspension(suspension);

      const firstClaim = await store.claimSuspension(suspension.id);
      expect(firstClaim).toBe(true);

      const secondClaim = await store.claimSuspension(suspension.id);
      expect(secondClaim).toBe(false);
    });

    it("returns false for a non-existent suspension id", async () => {
      const result = await store.claimSuspension("claim-nonexistent-id");
      expect(result).toBe(false);
    });

    it("returns false when the suspension was already resolved via markSuspensionResolved", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-resolved" });
      await store.saveSuspension(suspension);
      await store.markSuspensionResolved(suspension.id);

      const claimed = await store.claimSuspension(suspension.id);
      expect(claimed).toBe(false);
    });
  });
}
