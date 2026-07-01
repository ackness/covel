import { beforeEach, describe, expect, it } from "vitest";
import type {
  CharacterRecord,
  DataStore,
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
  makePluginConfig,
  makeRuntimeOutput,
  makeRuntimeResult,
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeSnapshotPayload,
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

export function registerRuntimeRecordStoreSuites(
  getStore: () => DataStore,
): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("Worlds", () => {
    it("should upsert and retrieve a world", async () => {
      const world = makeWorld();
      await store.upsertWorld(world);
      const result = await store.getWorld(world.id);
      expect(result).toEqual(world);
    });

    it("maps metadata.dimensions onto the world dimensions field", async () => {
      const dimensions = {
        geography: {
          regions: ["North"],
        },
      };
      const world = makeWorld({
        metadata: {
          dimensions,
          source: "contract",
        },
      });
      await store.upsertWorld(world);
      const result = await store.getWorld(world.id);
      expect(result?.metadata).toEqual(world.metadata);
      expect(result?.dimensions).toEqual(dimensions);
    });

    it("should list all worlds", async () => {
      const w1 = makeWorld();
      const w2 = makeWorld();
      await store.upsertWorld(w1);
      await store.upsertWorld(w2);
      const list = await store.listWorlds();
      expect(list).toHaveLength(2);
    });

    it("should return null for unknown world", async () => {
      const result = await store.getWorld("nonexistent");
      expect(result).toBeNull();
    });

    it("should delete a world", async () => {
      const world = makeWorld();
      await store.upsertWorld(world);
      await store.deleteWorld(world.id);
      const result = await store.getWorld(world.id);
      expect(result).toBeNull();
    });
  });

  describe("TraceEvents", () => {
    it("should add and list trace events", async () => {
      const te = makeTraceEvent({ sessionId: "sess-1" });
      await store.addTraceEvent(te);
      const list = await store.listTraceEvents("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(te);
    });

    it("parity: listTraceEvents returns events sorted by createdAt", async () => {
      // Backend-divergence regression guard. SQL backends order by
      // `asc(createdAt)`; memory relied on push order and IDB on the
      // primary-key (random uuid) index order, so both returned effectively
      // random order under out-of-order inserts — breaking turn grouping on
      // the browser-local backend. Insert deliberately out of chronological
      // order to prove the read path sorts.
      const e1 = makeTraceEvent({ sessionId: "sess-te", createdAt: ts(0) });
      const e2 = makeTraceEvent({ sessionId: "sess-te", createdAt: ts(100) });
      const e3 = makeTraceEvent({ sessionId: "sess-te", createdAt: ts(200) });
      await store.addTraceEvent(e2);
      await store.addTraceEvent(e3);
      await store.addTraceEvent(e1);
      const list = await store.listTraceEvents("sess-te");
      expect(list.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
    });

    it("parity: listTraceEvents pages a stable chronological window", async () => {
      const e1 = makeTraceEvent({ sessionId: "sess-te-pg", createdAt: ts(10) });
      const e2 = makeTraceEvent({ sessionId: "sess-te-pg", createdAt: ts(20) });
      const e3 = makeTraceEvent({ sessionId: "sess-te-pg", createdAt: ts(30) });
      await store.addTraceEvent(e3);
      await store.addTraceEvent(e1);
      await store.addTraceEvent(e2);

      const first2 = await store.listTraceEvents("sess-te-pg", { limit: 2 });
      expect(first2.map((e) => e.id)).toEqual([e1.id, e2.id]);

      const page2 = await store.listTraceEvents("sess-te-pg", {
        limit: 2,
        offset: 2,
      });
      expect(page2.map((e) => e.id)).toEqual([e3.id]);
    });
  });

  describe("RuntimeOutputs", () => {
    it("should save and get a runtime output by id", async () => {
      const ro = makeRuntimeOutput({ sessionId: "sess-1" });
      await store.saveRuntimeOutput(ro);
      const fetched = await store.getRuntimeOutput("sess-1", ro.id);
      expect(fetched).toBeTruthy();
      expect(fetched?.id).toBe(ro.id);
      expect(fetched?.runtimeId).toBe("narrator");
    });

    it("should return null for unknown runtime output", async () => {
      const missing = await store.getRuntimeOutput("sess-1", "nonexistent");
      expect(missing).toBeNull();
    });

    it("should filter by sessionId", async () => {
      await store.saveRuntimeOutput(makeRuntimeOutput({ sessionId: "sess-1" }));
      await store.saveRuntimeOutput(makeRuntimeOutput({ sessionId: "sess-2" }));
      const list = await store.listRuntimeOutputs("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0]!.sessionId).toBe("sess-1");
    });

    it("should filter by runtimeId", async () => {
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-1", runtimeId: "narrator" }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-1", runtimeId: "guide" }),
      );
      const list = await store.listRuntimeOutputs("sess-1", {
        runtimeId: "guide",
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.runtimeId).toBe("guide");
    });

    it("should filter by pluginId", async () => {
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-1", pluginId: "narrator" }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-1", pluginId: "guide" }),
      );
      const list = await store.listRuntimeOutputs("sess-1", {
        pluginId: "guide",
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.pluginId).toBe("guide");
    });

    it("should return results in newest-first order", async () => {
      const t1 = ts(100);
      const t2 = ts(300);
      const t3 = ts(200);
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-ord", timestamp: t1 }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-ord", timestamp: t2 }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-ord", timestamp: t3 }),
      );
      const list = await store.listRuntimeOutputs("sess-ord");
      expect(list).toHaveLength(3);
      expect(list[0]!.timestamp).toBe(t2);
      expect(list[1]!.timestamp).toBe(t3);
      expect(list[2]!.timestamp).toBe(t1);
    });

    it("should respect limit", async () => {
      for (let i = 0; i < 5; i++) {
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: "sess-lim", timestamp: ts(i * 10) }),
        );
      }
      const list = await store.listRuntimeOutputs("sess-lim", { limit: 2 });
      expect(list).toHaveLength(2);
    });

    it("should filter by sinceTimestamp", async () => {
      const tEarly = ts(100);
      const tLate = ts(500);
      const tMid = ts(200);
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-since", timestamp: tEarly }),
      );
      await store.saveRuntimeOutput(
        makeRuntimeOutput({ sessionId: "sess-since", timestamp: tLate }),
      );
      const list = await store.listRuntimeOutputs("sess-since", {
        sinceTimestamp: tMid,
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.timestamp).toBe(tLate);
    });
  });

  describe("InteractionRecords", () => {
    it("should save and list interaction records", async () => {
      const ir = makeInteractionRecord({ sessionId: "sess-ir" });
      await store.saveInteractionRecord(ir);
      const list = await store.listInteractionRecords("sess-ir");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(ir.id);
      expect(list[0]!.type).toBe("message");
    });

    it("should filter by sessionId", async () => {
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-1" }),
      );
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-2" }),
      );
      const list = await store.listInteractionRecords("sess-1");
      expect(list).toHaveLength(1);
    });

    it("should filter by type", async () => {
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-t", type: "message" }),
      );
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-t", type: "form-submit" }),
      );
      const list = await store.listInteractionRecords("sess-t", {
        type: "form-submit",
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.type).toBe("form-submit");
    });

    it("should filter by source", async () => {
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-s", source: "player" }),
      );
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-s", source: "plugin-ui" }),
      );
      const list = await store.listInteractionRecords("sess-s", {
        source: "plugin-ui",
      });
      expect(list).toHaveLength(1);
      expect(list[0]!.source).toBe("plugin-ui");
    });

    it("should return records in newest-first order", async () => {
      const tEarly = ts(100);
      const tLate = ts(300);
      await store.saveInteractionRecord(
        makeInteractionRecord({
          sessionId: "sess-ord-ir",
          timestamp: tEarly,
        }),
      );
      await store.saveInteractionRecord(
        makeInteractionRecord({ sessionId: "sess-ord-ir", timestamp: tLate }),
      );
      const list = await store.listInteractionRecords("sess-ord-ir");
      expect(list[0]!.timestamp).toBe(tLate);
    });

    it("should respect limit", async () => {
      for (let i = 0; i < 4; i++) {
        await store.saveInteractionRecord(
          makeInteractionRecord({
            sessionId: "sess-lim-ir",
            timestamp: ts(i * 10),
          }),
        );
      }
      const list = await store.listInteractionRecords("sess-lim-ir", {
        limit: 2,
      });
      expect(list).toHaveLength(2);
    });
  });

  describe("TurnMessages", () => {
    it("should appendTurnMessage and listTurnMessages", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-1", createdAt: ts(0) });
      const m2 = makeTurnMessage({ sessionId: "sess-1", createdAt: ts(100) });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);
      const list = await store.listTurnMessages("sess-1");
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe(m1.id);
      expect(list[1].id).toBe(m2.id);
    });

    it("should filter by sessionId", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-1" });
      const m2 = makeTurnMessage({ sessionId: "sess-2" });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);
      const list = await store.listTurnMessages("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(m1.id);
    });

    it("should return messages sorted by createdAt", async () => {
      const m1 = makeTurnMessage({
        sessionId: "sess-1",
        order: 100,
        createdAt: ts(200),
      });
      const m2 = makeTurnMessage({
        sessionId: "sess-1",
        order: 900,
        createdAt: ts(0),
      });
      const m3 = makeTurnMessage({
        sessionId: "sess-1",
        order: 500,
        createdAt: ts(100),
      });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);
      await store.appendTurnMessage(m3);
      const list = await store.listTurnMessages("sess-1");
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe(m2.id);
      expect(list[1].id).toBe(m3.id);
      expect(list[2].id).toBe(m1.id);
    });

    it("parity: appendTurnMessage persists a non-null compactedAtTurnId", async () => {
      // Backend-divergence regression guard: every backend must round-trip a
      // turn message that already carries `compactedAtTurnId`. The legacy
      // SQLite `appendTurnMessage` silently dropped the column (NULL default),
      // while PG/memory/idb preserved it — a real data-loss bug.
      const m = makeTurnMessage({
        sessionId: "sess-compacted",
        id: id(),
        compactedAtTurnId: "summary-preexisting",
      });
      await store.appendTurnMessage(m);
      const list = await store.listTurnMessages("sess-compacted");
      expect(list).toHaveLength(1);
      expect(list[0].compactedAtTurnId).toBe("summary-preexisting");
    });

    it("should support pagination with limit and offset", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-pg", createdAt: ts(10) });
      const m2 = makeTurnMessage({ sessionId: "sess-pg", createdAt: ts(20) });
      const m3 = makeTurnMessage({ sessionId: "sess-pg", createdAt: ts(30) });
      const m4 = makeTurnMessage({ sessionId: "sess-pg", createdAt: ts(40) });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);
      await store.appendTurnMessage(m3);
      await store.appendTurnMessage(m4);

      // limit only
      const first2 = await store.listTurnMessages("sess-pg", { limit: 2 });
      expect(first2).toHaveLength(2);
      expect(first2[0].id).toBe(m1.id);
      expect(first2[1].id).toBe(m2.id);

      // limit + offset
      const page2 = await store.listTurnMessages("sess-pg", {
        limit: 2,
        offset: 2,
      });
      expect(page2).toHaveLength(2);
      expect(page2[0].id).toBe(m3.id);
      expect(page2[1].id).toBe(m4.id);

      // offset beyond end
      const empty = await store.listTurnMessages("sess-pg", {
        limit: 10,
        offset: 100,
      });
      expect(empty).toHaveLength(0);
    });

    it("listRecentTurnMessages returns the newest N, oldest-first", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-tail", createdAt: ts(10) });
      const m2 = makeTurnMessage({ sessionId: "sess-tail", createdAt: ts(20) });
      const m3 = makeTurnMessage({ sessionId: "sess-tail", createdAt: ts(30) });
      const m4 = makeTurnMessage({ sessionId: "sess-tail", createdAt: ts(40) });
      // Insert out of chronological order to prove the query orders by createdAt,
      // not by insertion order.
      await store.appendTurnMessage(m3);
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m4);
      await store.appendTurnMessage(m2);

      // Newest 2 → the tail of the ascending list, still oldest-first.
      const recent2 = await store.listRecentTurnMessages("sess-tail", 2);
      expect(recent2.map((m) => m.id)).toEqual([m3.id, m4.id]);

      // Limit larger than the row count returns everything (ascending).
      const all = await store.listRecentTurnMessages("sess-tail", 10);
      expect(all.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id, m4.id]);
    });

    it("listRecentTurnMessages returns [] for a non-positive limit", async () => {
      await store.appendTurnMessage(
        makeTurnMessage({ sessionId: "sess-tail-zero", createdAt: ts(0) }),
      );
      expect(await store.listRecentTurnMessages("sess-tail-zero", 0)).toEqual(
        [],
      );
      expect(await store.listRecentTurnMessages("sess-tail-zero", -5)).toEqual(
        [],
      );
    });

    it("listRecentTurnMessages filters by sessionId", async () => {
      await store.appendTurnMessage(
        makeTurnMessage({ sessionId: "sess-tail-a", createdAt: ts(0) }),
      );
      await store.appendTurnMessage(
        makeTurnMessage({ sessionId: "sess-tail-b", createdAt: ts(0) }),
      );
      const a = await store.listRecentTurnMessages("sess-tail-a", 10);
      expect(a).toHaveLength(1);
      expect(a[0].sessionId).toBe("sess-tail-a");
    });
  });

  describe("PlayerInputs", () => {
    it("should savePlayerInput and getPlayerInput", async () => {
      const input = makePlayerInput({
        sessionId: "sess-1",
        formId: "form-a",
      });
      await store.savePlayerInput(input);
      const result = await store.getPlayerInput("sess-1", "form-a");
      expect(result).toEqual(input);
    });

    it("should return null for unknown playerInput", async () => {
      const result = await store.getPlayerInput("sess-1", "nonexistent");
      expect(result).toBeNull();
    });

    it("should listPlayerInputs for a session", async () => {
      const i1 = makePlayerInput({ sessionId: "sess-1", formId: "form-a" });
      const i2 = makePlayerInput({ sessionId: "sess-1", formId: "form-b" });
      const i3 = makePlayerInput({ sessionId: "sess-2", formId: "form-c" });
      await store.savePlayerInput(i1);
      await store.savePlayerInput(i2);
      await store.savePlayerInput(i3);
      const list = await store.listPlayerInputs("sess-1");
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.id)).toContain(i1.id);
      expect(list.map((r) => r.id)).toContain(i2.id);
    });
  });

  describe("WorkingMemory", () => {
    it("upsert + get roundtrip", async () => {
      const wm = makeWorkingMemory({
        sessionId: "wm-sess",
        scope: "player",
        key: "prefs",
      });
      await store.upsertWorkingMemory(wm);
      const result = await store.getWorkingMemory("wm-sess", "player", "prefs");
      expect(result).not.toBeNull();
      expect(result!.key).toBe("prefs");
      expect(result!.scope).toBe("player");
      expect(result!.sessionId).toBe("wm-sess");
      expect(result!.value).toEqual(wm.value);
    });

    it("preserves null values", async () => {
      const wm = makeWorkingMemory({
        sessionId: "wm-null",
        scope: "player",
        key: "prefs",
        value: null,
      });
      await store.upsertWorkingMemory(wm);
      const result = await store.getWorkingMemory("wm-null", "player", "prefs");
      expect(result?.value).toBeNull();
    });

    it("list returns all entries for a session", async () => {
      const w1 = makeWorkingMemory({
        sessionId: "wm-list",
        scope: "player",
        key: "a",
      });
      const w2 = makeWorkingMemory({
        sessionId: "wm-list",
        scope: "story",
        key: "b",
      });
      const w3 = makeWorkingMemory({
        sessionId: "wm-list",
        scope: "shared",
        key: "c",
      });
      await store.upsertWorkingMemory(w1);
      await store.upsertWorkingMemory(w2);
      await store.upsertWorkingMemory(w3);
      const list = await store.listWorkingMemory("wm-list");
      expect(list).toHaveLength(3);
      const keys = list.map((r) => r.key);
      expect(keys).toContain("a");
      expect(keys).toContain("b");
      expect(keys).toContain("c");
    });

    it("parity: lists entries in semantic scope order (player → story → shared)", async () => {
      // Insert scrambled; every backend must return semantic scope order then
      // key. Alphabetical scope ordering ([player, shared, story]) would fail
      // here, catching the SQL-vs-Memory/IDB divergence.
      await store.upsertWorkingMemory(
        makeWorkingMemory({ sessionId: "wm-order", scope: "shared", key: "s" }),
      );
      await store.upsertWorkingMemory(
        makeWorkingMemory({ sessionId: "wm-order", scope: "story", key: "t" }),
      );
      await store.upsertWorkingMemory(
        makeWorkingMemory({ sessionId: "wm-order", scope: "player", key: "p" }),
      );
      const list = await store.listWorkingMemory("wm-order");
      expect(list.map((r) => r.scope)).toEqual(["player", "story", "shared"]);
    });

    it("upsert-on-conflict replaces the record (same sessionId+scope+key)", async () => {
      const wm = makeWorkingMemory({
        sessionId: "wm-upsert",
        scope: "player",
        key: "pref",
        value: "v1",
      });
      await store.upsertWorkingMemory(wm);

      const wmUpdated = makeWorkingMemory({
        sessionId: "wm-upsert",
        scope: "player",
        key: "pref",
        value: "v2",
      });
      await store.upsertWorkingMemory(wmUpdated);

      const list = await store.listWorkingMemory("wm-upsert");
      expect(list).toHaveLength(1);
      expect(list[0].value).toBe("v2");
    });

    it("delete removes only the targeted entry", async () => {
      const w1 = makeWorkingMemory({
        sessionId: "wm-del",
        scope: "player",
        key: "keep",
      });
      const w2 = makeWorkingMemory({
        sessionId: "wm-del",
        scope: "player",
        key: "remove",
      });
      await store.upsertWorkingMemory(w1);
      await store.upsertWorkingMemory(w2);

      await store.deleteWorkingMemory("wm-del", "player", "remove");

      const list = await store.listWorkingMemory("wm-del");
      expect(list).toHaveLength(1);
      expect(list[0].key).toBe("keep");

      const removed = await store.getWorkingMemory(
        "wm-del",
        "player",
        "remove",
      );
      expect(removed).toBeNull();
    });

    it("different sessions do not leak", async () => {
      await store.upsertWorkingMemory(
        makeWorkingMemory({
          sessionId: "wm-sess-A",
          scope: "player",
          key: "k",
          value: "A",
        }),
      );
      await store.upsertWorkingMemory(
        makeWorkingMemory({
          sessionId: "wm-sess-B",
          scope: "player",
          key: "k",
          value: "B",
        }),
      );

      const listA = await store.listWorkingMemory("wm-sess-A");
      const listB = await store.listWorkingMemory("wm-sess-B");
      expect(listA).toHaveLength(1);
      expect(listA[0].value).toBe("A");
      expect(listB).toHaveLength(1);
      expect(listB[0].value).toBe("B");
    });

    it("same key under different scopes are distinct records", async () => {
      const sessId = "wm-scopes";
      await store.upsertWorkingMemory(
        makeWorkingMemory({
          sessionId: sessId,
          scope: "player",
          key: "sameKey",
          value: "player-val",
        }),
      );
      await store.upsertWorkingMemory(
        makeWorkingMemory({
          sessionId: sessId,
          scope: "story",
          key: "sameKey",
          value: "story-val",
        }),
      );

      const playerEntry = await store.getWorkingMemory(
        sessId,
        "player",
        "sameKey",
      );
      const storyEntry = await store.getWorkingMemory(
        sessId,
        "story",
        "sameKey",
      );
      expect(playerEntry).not.toBeNull();
      expect(storyEntry).not.toBeNull();
      expect(playerEntry!.value).toBe("player-val");
      expect(storyEntry!.value).toBe("story-val");

      const list = await store.listWorkingMemory(sessId);
      expect(list).toHaveLength(2);
    });

    it("rollback inside a transaction undoes working memory writes", async () => {
      const wm = makeWorkingMemory({
        sessionId: "wm-rollback",
        scope: "player",
        key: "rolled",
      });
      await store.beginTx();
      await store.upsertWorkingMemory(wm);
      await store.rollbackTx();

      const result = await store.getWorkingMemory(
        "wm-rollback",
        "player",
        "rolled",
      );
      expect(result).toBeNull();
    });
  });

  describe("WorldDataImportLedger", () => {
    it("saves a batch and lists rows sorted by importedAt then id", async () => {
      const first = makeWorldDataImportLedger({
        id: "ledger-a",
        sessionId: "ledger-batch",
        importedAt: ts(0),
        derivedFrom: ["source-root"],
      });
      const second = makeWorldDataImportLedger({
        id: "ledger-b",
        sessionId: "ledger-batch",
        target: "working-memory",
        pluginId: undefined,
        namespace: undefined,
        key: undefined,
        schemaRef: undefined,
        derivedFrom: undefined,
        importedAt: ts(0),
        managed: false,
      });

      await store.saveWorldDataImportLedgerBatch([second, first]);

      const list = await store.listWorldDataImportLedger("ledger-batch");
      expect(list.map((r) => r.id)).toEqual(["ledger-a", "ledger-b"]);
      expect(list[0].derivedFrom).toEqual(["source-root"]);
      expect(list[1].pluginId).toBeUndefined();
      expect(list[1].managed).toBe(false);
    });

    it("isolates rows by sessionId", async () => {
      await store.saveWorldDataImportLedgerBatch([
        makeWorldDataImportLedger({
          id: "ledger-session-a",
          sessionId: "ledger-A",
        }),
        makeWorldDataImportLedger({
          id: "ledger-session-b",
          sessionId: "ledger-B",
        }),
      ]);

      const a = await store.listWorldDataImportLedger("ledger-A");
      const b = await store.listWorldDataImportLedger("ledger-B");
      expect(a.map((r) => r.id)).toEqual(["ledger-session-a"]);
      expect(b.map((r) => r.id)).toEqual(["ledger-session-b"]);
    });

    it("rolls back ledger writes inside a transaction", async () => {
      await store.beginTx();
      await store.saveWorldDataImportLedgerBatch([
        makeWorldDataImportLedger({
          id: "ledger-rollback-row",
          sessionId: "ledger-rollback",
        }),
      ]);
      await store.rollbackTx();

      const list = await store.listWorldDataImportLedger("ledger-rollback");
      expect(list).toHaveLength(0);
    });

    it("deletes one ledger row by sessionId and id", async () => {
      await store.saveWorldDataImportLedgerBatch([
        makeWorldDataImportLedger({
          id: "ledger-delete",
          sessionId: "ledger-delete-session",
        }),
        makeWorldDataImportLedger({
          id: "ledger-keep",
          sessionId: "ledger-delete-other",
        }),
      ]);

      await store.deleteWorldDataImportLedger(
        "ledger-delete-session",
        "ledger-delete",
      );
      await store.deleteWorldDataImportLedger(
        "ledger-delete-session",
        "ledger-keep",
      );

      expect(
        await store.listWorldDataImportLedger("ledger-delete-session"),
      ).toEqual([]);
      expect(
        (await store.listWorldDataImportLedger("ledger-delete-other")).map(
          (r) => r.id,
        ),
      ).toEqual(["ledger-keep"]);
    });
  });

  describe("SessionSummaries", () => {
    it("should saveSessionSummary and listSessionSummaries", async () => {
      const s = makeSessionSummary({ sessionId: "sess-sum-1" });
      await store.saveSessionSummary(s);
      const list = await store.listSessionSummaries("sess-sum-1");
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: s.id,
        sessionId: s.sessionId,
        content: s.content,
        focusSections: s.focusSections,
      });
    });

    it("should return empty list for unknown session", async () => {
      const list = await store.listSessionSummaries("nonexistent-session");
      expect(list).toHaveLength(0);
    });

    it("should filter summaries by sessionId", async () => {
      const s1 = makeSessionSummary({ sessionId: "sess-sum-filter-1" });
      const s2 = makeSessionSummary({ sessionId: "sess-sum-filter-2" });
      await store.saveSessionSummary(s1);
      await store.saveSessionSummary(s2);
      const list1 = await store.listSessionSummaries("sess-sum-filter-1");
      expect(list1).toHaveLength(1);
      expect(list1[0].id).toBe(s1.id);
    });

    it("should deleteSessionSummaries by sessionId", async () => {
      const s1 = makeSessionSummary({ sessionId: "sess-sum-del" });
      const s2 = makeSessionSummary({ sessionId: "sess-sum-del" });
      await store.saveSessionSummary(s1);
      await store.saveSessionSummary(s2);
      await store.deleteSessionSummaries("sess-sum-del");
      const list = await store.listSessionSummaries("sess-sum-del");
      expect(list).toHaveLength(0);
    });

    it("should not delete summaries for other sessions", async () => {
      const keep = makeSessionSummary({ sessionId: "sess-sum-keep" });
      const del = makeSessionSummary({ sessionId: "sess-sum-nodel" });
      await store.saveSessionSummary(keep);
      await store.saveSessionSummary(del);
      await store.deleteSessionSummaries("sess-sum-nodel");
      const list = await store.listSessionSummaries("sess-sum-keep");
      expect(list).toHaveLength(1);
    });

    it("should tagTurnMessagesCompacted — set compactedAtTurnId", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-tag-1", id: id() });
      const m2 = makeTurnMessage({ sessionId: "sess-tag-1", id: id() });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);

      const summaryId = "summary-abc";
      await store.tagTurnMessagesCompacted(
        "sess-tag-1",
        [m1.id, m2.id],
        summaryId,
      );

      const messages = await store.listTurnMessages("sess-tag-1");
      for (const msg of messages) {
        expect(msg.compactedAtTurnId).toBe(summaryId);
      }
    });

    it("parity: tagTurnMessagesCompacted with no messageIds is a no-op", async () => {
      // Every backend must treat an empty id list as a no-op (no error, no
      // mutation). Guards the shared early-return that previously existed only
      // in the PG backend.
      const m = makeTurnMessage({ sessionId: "sess-tag-empty", id: id() });
      await store.appendTurnMessage(m);
      await store.tagTurnMessagesCompacted(
        "sess-tag-empty",
        [],
        "summary-noop",
      );
      const messages = await store.listTurnMessages("sess-tag-empty");
      expect(messages).toHaveLength(1);
      expect(messages[0].compactedAtTurnId).toBeUndefined();
    });

    it("should not tag messages from other sessions", async () => {
      const m1 = makeTurnMessage({ sessionId: "sess-tag-a", id: id() });
      const m2 = makeTurnMessage({ sessionId: "sess-tag-b", id: id() });
      await store.appendTurnMessage(m1);
      await store.appendTurnMessage(m2);

      await store.tagTurnMessagesCompacted(
        "sess-tag-a",
        [m1.id, m2.id],
        "summary-xyz",
      );

      const bMessages = await store.listTurnMessages("sess-tag-b");
      expect(bMessages[0].compactedAtTurnId).toBeUndefined();
    });

    it("should rollback saveSessionSummary in a transaction", async () => {
      const s = makeSessionSummary({ sessionId: "sess-sum-tx" });
      await store.beginTx();
      await store.saveSessionSummary(s);
      await store.rollbackTx();
      const list = await store.listSessionSummaries("sess-sum-tx");
      expect(list).toHaveLength(0);
    });

    it("should rollback tagTurnMessagesCompacted in a transaction", async () => {
      const m = makeTurnMessage({ sessionId: "sess-tag-tx", id: id() });
      await store.appendTurnMessage(m);

      await store.beginTx();
      await store.tagTurnMessagesCompacted(
        "sess-tag-tx",
        [m.id],
        "summary-rollback",
      );
      await store.rollbackTx();

      const messages = await store.listTurnMessages("sess-tag-tx");
      expect(messages[0].compactedAtTurnId).toBeUndefined();
    });
  });
}
