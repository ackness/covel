import { beforeEach, describe, expect, it } from "vitest";
import type { DataStore, SnapshotPayload } from "../../types.js";
import {
  makeLorebookEntry,
  makeSessionSummary,
  makeSnapshot,
  makeSnapshotPayload,
  makeSuspension,
  ts,
} from "../test-fixtures.js";

export function registerPersistenceStoreSuites(
  getStore: () => DataStore,
): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("Suspensions", () => {
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
      expect(listB[0]!.id).toBe(s3.id);
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

    it("should markSuspensionResolved — sets resolvedAt and drops the consumed continuation", async () => {
      const base = makeSuspension({ sessionId: "sess-susp-res" });
      const suspension = {
        ...base,
        pendingContinuation: {
          ...base.pendingContinuation,
          messages: [{ role: "system", content: "x".repeat(20_000) }],
          toolCallsSoFar: [{ name: "ask" }],
          pendingProposals: [{ type: "state.patch" }],
          partialContent: "Half a sentence",
          suspendToolCallId: "call-1",
          emittedEvents: [{ topic: "t" }],
          locale: "en-US",
          logicalTurn: 3,
        },
      };
      await store.saveSuspension(suspension);
      await store.markSuspensionResolved(suspension.id);

      const result = await store.getSuspension(suspension.id);
      expect(result).not.toBeNull();
      expect(result!.resolvedAt).not.toBeUndefined();
      // Other fields unchanged
      expect(result!.reason).toBe(suspension.reason);
      expect(result!.runtimeId).toBe(suspension.runtimeId);
      expect(result!.resumeSchema).toEqual(suspension.resumeSchema);
      // The identity of the execution stays; what the resume consumed goes.
      expect(result!.pendingContinuation).toEqual({
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: [],
        executionContext: suspension.pendingContinuation.executionContext,
        locale: "en-US",
        logicalTurn: 3,
      });
      // A claim keeps everything: its resume has not committed yet.
      const claimed = makeSuspension({ sessionId: "sess-susp-res" });
      await store.saveSuspension(claimed);
      await store.claimSuspension(claimed.id);
      expect(
        (await store.getSuspension(claimed.id))!.pendingContinuation,
      ).toEqual(claimed.pendingContinuation);
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

    // ── deleteExpiredSuspensions (TTL sweep) ──────────────
    // A global maintenance sweep: deletes ONLY records that are still
    // unresolved (resolvedAt unset) AND older than the supplied cutoff.
    // Claimed (in-flight, `claimed:<iso>`) and successfully-resolved
    // records must never be touched. Must behave identically on every
    // backend (store-backend-parity rule).
    describe("deleteExpiredSuspensions (TTL sweep)", () => {
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
        expect(await store.claimSuspension(old.id)).not.toBeNull();

        const deleted = await store.deleteExpiredSuspensions(CUTOFF);

        expect(deleted).toBe(0);
        expect(await store.getSuspension(old.id)).not.toBeNull();
      });

      it("releases a claim older than the cutoff and leaves the rest", async () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
        const stale = makeSuspension({ sessionId: "sess-ttl" });
        const live = makeSuspension({ sessionId: "sess-ttl" });
        const resolved = makeSuspension({ sessionId: "sess-ttl" });
        for (const record of [stale, live, resolved])
          await store.saveSuspension(record);
        await store.claimSuspension(stale.id);
        await pause();
        const between = new Date().toISOString();
        await pause();
        await store.claimSuspension(live.id);
        await store.markSuspensionResolved(resolved.id);

        expect(await store.releaseStaleSuspensionClaims(between)).toBe(1);

        expect(await store.claimSuspension(stale.id)).not.toBeNull();
        expect(await store.claimSuspension(live.id)).toBeNull();
        expect(await store.claimSuspension(resolved.id)).toBeNull();
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

  describe("LorebookEntries", () => {
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
      expect(list[0]!.keys).toEqual(["ancient", "temple"]);
      expect(list[0]!.strategy).toBe("selective");
      expect(list[2]!.enabled).toBe(false);
      expect(list[2]!.extra).toEqual({
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
      expect(list[0]!.content).toBe("updated");
      expect(list[0]!.insertionOrder).toBe(50);
    });

    it("isolates identical ids across owners for reads, updates, and deletes", async () => {
      const owners = [
        { kind: "world" as const },
        { kind: "player" as const },
        { kind: "plugin" as const, pluginId: "plugin:a" },
        { kind: "plugin" as const, pluginId: "plugin:b" },
      ];
      await store.upsertLorebookEntries(
        owners.map((owner, index) =>
          makeLorebookEntry({
            sessionId: "owner-test",
            id: "shared-id",
            owner,
            content: `owner-${index}`,
          }),
        ),
      );
      for (const [index, owner] of owners.entries()) {
        expect(
          await store.getLorebookEntry("owner-test", owner, "shared-id"),
        ).toMatchObject({ owner, content: `owner-${index}` });
      }
      const own = await store.getLorebookEntry(
        "owner-test",
        owners[2]!,
        "shared-id",
      );
      await store.upsertLorebookEntries([{ ...own!, content: "updated" }]);
      expect(
        (await store.getLorebookEntry("owner-test", owners[3]!, "shared-id"))
          ?.content,
      ).toBe("owner-3");
      await store.deleteLorebookEntry("owner-test", owners[2]!, "shared-id");
      expect(
        await store.getLorebookEntry("owner-test", owners[2]!, "shared-id"),
      ).toBeNull();
      expect(await store.listSessionLorebookEntries("owner-test")).toHaveLength(
        3,
      );
    });

    it("isolates entries by sessionId", async () => {
      await store.upsertLorebookEntries([
        makeLorebookEntry({
          id: "lore-shared",
          sessionId: "sess-lore-A",
          content: "session A",
        }),
        makeLorebookEntry({
          id: "lore-shared",
          sessionId: "sess-lore-B",
          content: "session B",
        }),
      ]);

      const a = await store.listSessionLorebookEntries("sess-lore-A");
      const b = await store.listSessionLorebookEntries("sess-lore-B");
      expect(a).toMatchObject([{ id: "lore-shared", content: "session A" }]);
      expect(b).toMatchObject([{ id: "lore-shared", content: "session B" }]);
    });

    it("deleteLorebookEntry removes a single entry by sessionId+id", async () => {
      await store.upsertLorebookEntries([
        makeLorebookEntry({ id: "lore-keep", sessionId: "sess-lore-del" }),
        makeLorebookEntry({ id: "lore-drop", sessionId: "sess-lore-del" }),
      ]);

      await store.deleteLorebookEntry(
        "sess-lore-del",
        { kind: "plugin", pluginId: "plugin-1" },
        "lore-drop",
      );
      const list = await store.listSessionLorebookEntries("sess-lore-del");
      expect(list.map((r) => r.id)).toEqual(["lore-keep"]);
    });
  });

  describe("Snapshots", () => {
    it("refreshes an existing snapshot's capture time, payload and newest-page position", async () => {
      const original = makeSnapshot({
        id: "snapshot-a",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "auto",
      });
      const middle = makeSnapshot({
        id: "snapshot-b",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      const refreshed = {
        ...original,
        createdAt: "2026-01-01T00:00:02.000Z",
        turnId: "new-turn",
        payload: makeSnapshotPayload({ messagesCursor: "new-message" }),
      };
      await store.saveSnapshot(original);
      await store.saveSnapshot(middle);
      await expect(store.saveSnapshot(refreshed)).resolves.toBeUndefined();
      expect(await store.getSnapshot(original.id)).toEqual(refreshed);
      expect(await store.listSnapshots(original.sessionId)).toEqual([
        middle,
        refreshed,
      ]);
      const newest = await store.listSnapshotsPage(original.sessionId, {
        limit: 1,
      });
      expect(newest).toEqual([
        expect.objectContaining({
          id: original.id,
          createdAt: refreshed.createdAt,
        }),
      ]);
      expect(
        (
          await store.listSnapshotsPage(original.sessionId, {
            limit: 1,
            before: newest[0],
          })
        ).map((row) => row.id),
      ).toEqual([middle.id]);
    });

    it("rolls back snapshot refresh time and payload with its transaction", async () => {
      const original = makeSnapshot({
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "auto",
      });
      await store.saveSnapshot(original);
      await expect(
        store.withTransaction(async (tx) => {
          await tx.saveSnapshot({
            ...original,
            createdAt: "2026-01-01T00:00:02.000Z",
            payload: makeSnapshotPayload({ messagesCursor: "rolled-back" }),
          });
          expect((await tx.getSnapshot(original.id))?.createdAt).toBe(
            "2026-01-01T00:00:02.000Z",
          );
          throw new Error("rollback refresh");
        }),
      ).rejects.toThrow("rollback refresh");
      expect(await store.getSnapshot(original.id)).toEqual(original);
    });

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
      expect(listA[0]!.id).toBe(s1.id);
      expect(listA[1]!.id).toBe(s2.id);

      const listB = await store.listSnapshots("sess-snap-B");
      expect(listB).toHaveLength(1);
      expect(listB[0]!.id).toBe(s3.id);
    });

    it("should persist all payload slices verbatim", async () => {
      const payload = makeSnapshotPayload({
        characterSchema: null,
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
        sessionSummaries: [
          makeSessionSummary({
            id: "summary-1",
            sessionId: "sess-snap-pay",
          }),
        ],
        messagesCursor: "tm-last-abc",
      });
      const snap = makeSnapshot({ sessionId: "sess-snap-pay", payload });
      await store.saveSnapshot(snap);

      const result = await store.getSnapshot(snap.id);
      expect(result).not.toBeNull();
      expect(result!.payload.characters).toHaveLength(1);
      expect(result!.payload.characters[0]!.name).toBe("Hero");
      expect(result!.payload.stateEntries[0]!.value).toBe(100);
      expect(result!.payload.pluginData[0]!.value).toEqual({ a: 1 });
      expect(result!.payload.sessionSummaries).toEqual([
        expect.objectContaining({ id: "summary-1" }),
      ]);
      expect(result!.payload.messagesCursor).toBe("tm-last-abc");
    });

    it("round-trips the current snapshot session lifecycle state", async () => {
      const payload = makeSnapshotPayload();
      const snap = makeSnapshot({ sessionId: "sess-snap-current", payload });
      await store.saveSnapshot(snap);

      const result = (await store.getSnapshot(snap.id))!
        .payload as SnapshotPayload;
      expect(result.schemaVersion).toBe(3);
      expect(result.session).toEqual(payload.session);
    });

    it("keeps optional session fields absent after round-trip", async () => {
      // Optional runtimeModelOverrides must not reappear as null after JSON
      // serialization (store-backend parity contract).
      const payload = makeSnapshotPayload({
        session: {
          status: "paused",
          locale: "en-US",
          activePlugins: [],
          phase: "setup",
          completedPlayerTurns: 0,
          setupRuntimes: {},
        },
      });
      const snap = makeSnapshot({ sessionId: "sess-snap-current", payload });
      await store.saveSnapshot(snap);

      const result = (await store.getSnapshot(snap.id))!
        .payload as SnapshotPayload;
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

  describe("listSnapshotsPage (metadata projection + keyset pagination)", () => {
    it("returns metadata WITHOUT the payload, sized > 0", async () => {
      const sessionId = "sess-snap-meta";
      const big = makeSnapshotPayload({
        characterSchema: null,
        characters: Array.from({ length: 20 }, (_, i) => ({
          id: `char-${i}`,
          sessionId,
          name: `Hero ${i}`,
          type: "npc" as const,
          version: 1,
          createdAt: ts(),
          updatedAt: ts(),
        })),
      });
      const small = makeSnapshot({
        id: "snap-small",
        sessionId,
        turnId: "turn-a",
        kind: "manual",
        createdAt: ts(0),
      });
      const large = makeSnapshot({
        id: "snap-large",
        sessionId,
        turnId: "turn-b",
        kind: "auto",
        payload: big,
        createdAt: ts(1000),
      });
      await store.saveSnapshot(small);
      await store.saveSnapshot(large);

      const page = await store.listSnapshotsPage(sessionId, { limit: 10 });
      expect(page).toHaveLength(2);
      // Oldest-first within the page (mirrors listMessagesPage).
      expect(page.map((m) => m.id)).toEqual(["snap-small", "snap-large"]);

      const largeMeta = page[1]!;
      expect(largeMeta.turnId).toBe("turn-b");
      expect(largeMeta.kind).toBe("auto");
      // Payload is projected away; only its serialized length survives.
      expect(largeMeta).not.toHaveProperty("payload");
      expect(largeMeta.size).toBeGreaterThan(0);
      // A heavier payload yields a larger recorded size.
      expect(largeMeta.size).toBeGreaterThan(page[0]!.size);
    });

    it("keyset-paginates newest-first via the `before` cursor", async () => {
      const sessionId = "sess-snap-page";
      for (let i = 0; i < 5; i++) {
        await store.saveSnapshot(
          makeSnapshot({
            id: `snap-${i}`,
            sessionId,
            turnId: `turn-${i}`,
            createdAt: ts(i * 1000),
          }),
        );
      }

      // First page = newest window, oldest-first inside the page.
      const first = await store.listSnapshotsPage(sessionId, { limit: 2 });
      expect(first.map((m) => m.id)).toEqual(["snap-3", "snap-4"]);

      // Cursor = oldest row of the page just returned; next page is older.
      const oldest = first[0]!;
      const second = await store.listSnapshotsPage(sessionId, {
        limit: 2,
        before: { createdAt: oldest.createdAt, id: oldest.id },
      });
      expect(second.map((m) => m.id)).toEqual(["snap-1", "snap-2"]);

      const third = await store.listSnapshotsPage(sessionId, {
        limit: 2,
        before: { createdAt: second[0]!.createdAt, id: second[0]!.id },
      });
      expect(third.map((m) => m.id)).toEqual(["snap-0"]);
    });

    it("returns [] for limit <= 0", async () => {
      const page = await store.listSnapshotsPage("sess-any", { limit: 0 });
      expect(page).toEqual([]);
    });
  });

  describe("claimSuspension", () => {
    it("returns the claim marker on first claim and atomically sets resolvedAt", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-ok" });
      await store.saveSuspension(suspension);

      const claim = await store.claimSuspension(suspension.id);
      expect(claim).toMatch(/^claimed:/);

      const afterClaim = await store.getSuspension(suspension.id);
      expect(afterClaim!.resolvedAt).toBe(claim);
    });

    it("returns null on a subsequent claim (already claimed)", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-conflict" });
      await store.saveSuspension(suspension);

      expect(await store.claimSuspension(suspension.id)).not.toBeNull();
      expect(await store.claimSuspension(suspension.id)).toBeNull();
    });

    it("returns null for a non-existent suspension id", async () => {
      expect(await store.claimSuspension("claim-nonexistent-id")).toBeNull();
    });

    it("returns null when the suspension was already resolved via markSuspensionResolved", async () => {
      const suspension = makeSuspension({ sessionId: "sess-claim-resolved" });
      await store.saveSuspension(suspension);
      await store.markSuspensionResolved(suspension.id);

      expect(await store.claimSuspension(suspension.id)).toBeNull();
    });
  });

  describe("releaseSuspensionClaim", () => {
    it("makes the suspension claimable again for the claim's owner", async () => {
      const suspension = makeSuspension({ sessionId: "sess-release-own" });
      await store.saveSuspension(suspension);
      const claim = (await store.claimSuspension(suspension.id))!;

      expect(await store.releaseSuspensionClaim(suspension.id, claim)).toBe(
        true,
      );
      expect(
        (await store.getSuspension(suspension.id))!.resolvedAt,
      ).toBeUndefined();
      expect(await store.claimSuspension(suspension.id)).not.toBeNull();
    });

    it("leaves a resolved suspension resolved", async () => {
      const suspension = makeSuspension({ sessionId: "sess-release-done" });
      await store.saveSuspension(suspension);
      const claim = (await store.claimSuspension(suspension.id))!;
      await store.markSuspensionResolved(suspension.id);
      const resolvedAt = (await store.getSuspension(suspension.id))!.resolvedAt;

      expect(await store.releaseSuspensionClaim(suspension.id, claim)).toBe(
        false,
      );
      expect((await store.getSuspension(suspension.id))!.resolvedAt).toBe(
        resolvedAt,
      );
      expect(await store.claimSuspension(suspension.id)).toBeNull();
    });

    it("leaves a claim that another resume took after a stale release", async () => {
      const suspension = makeSuspension({ sessionId: "sess-release-other" });
      await store.saveSuspension(suspension);
      const stale = "claimed:2000-01-01T00:00:00.000Z";
      await store.saveSuspension({ ...suspension, resolvedAt: stale });
      expect(
        await store.releaseStaleSuspensionClaims("2001-01-01T00:00:00.000Z"),
      ).toBe(1);
      const live = (await store.claimSuspension(suspension.id))!;

      expect(await store.releaseSuspensionClaim(suspension.id, stale)).toBe(
        false,
      );
      expect((await store.getSuspension(suspension.id))!.resolvedAt).toBe(live);
    });

    it("returns false for a suspension that no longer exists", async () => {
      expect(
        await store.releaseSuspensionClaim(
          "release-nonexistent-id",
          "claimed:x",
        ),
      ).toBe(false);
    });
  });
}
