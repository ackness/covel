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

export function registerIntegrityStoreSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("deleteSession cascade", () => {
    it("removes all session-scoped rows across every collection", async () => {
      const sessionId = "sess-cascade";
      const otherId = "sess-cascade-keep";

      // Seed target session across every known child collection.
      await store.createSession(makeSession({ id: sessionId }));
      await store.createSession(makeSession({ id: otherId }));

      await store.saveTurnResult(makeTurnResult({ sessionId }));
      await store.saveRuntimeResult(makeRuntimeResult({ sessionId }));
      await store.saveToolCall(makeToolCall({ sessionId }));
      await store.saveStateSchema(makeStateSchema({ sessionId }));
      await store.upsertStateEntry(makeStateEntry({ sessionId }));
      await store.addStateChange(makeStateChange({ sessionId }));
      await store.saveEvent(makeEvent({ sessionId }));
      await store.saveApproval(makeApproval({ sessionId }));
      await store.addMessage(makeMessage({ sessionId }));
      await store.upsertCharacter(makeCharacter({ sessionId }));
      await store.savePluginConfig(makePluginConfig({ sessionId }));
      await store.addTraceEvent(makeTraceEvent({ sessionId }));
      await store.saveRuntimeOutput(makeRuntimeOutput({ sessionId }));
      await store.saveInteractionRecord(makeInteractionRecord({ sessionId }));
      await store.appendTurnMessage(makeTurnMessage({ sessionId }));
      await store.savePlayerInput(makePlayerInput({ sessionId }));
      await store.upsertWorkingMemory(makeWorkingMemory({ sessionId }));
      await store.saveWorldDataImportLedgerBatch([
        makeWorldDataImportLedger({ sessionId }),
      ]);
      await store.upsertLorebookEntries([makeLorebookEntry({ sessionId })]);
      await store.saveSessionSummary(makeSessionSummary({ sessionId }));
      await store.saveSuspension(makeSuspension({ sessionId }));
      await store.saveSnapshot(makeSnapshot({ sessionId }));
      await store.setPluginData({
        id: id(),
        sessionId,
        pluginId: "plugin-1",
        namespace: "ns",
        key: "k",
        value: { v: 1 },
        createdAt: ts(),
        updatedAt: ts(),
      });

      // Seed a parallel session to prove the cascade is scoped.
      await store.saveTurnResult(makeTurnResult({ sessionId: otherId }));
      await store.saveSuspension(makeSuspension({ sessionId: otherId }));
      await store.upsertWorkingMemory(
        makeWorkingMemory({ sessionId: otherId }),
      );
      await store.upsertLorebookEntries([
        makeLorebookEntry({ sessionId: otherId }),
      ]);

      // Cascade.
      await store.deleteSession(sessionId);

      // Target session: every collection empty.
      expect(await store.getSession(sessionId)).toBeNull();
      expect(await store.listTurnResults(sessionId)).toHaveLength(0);
      expect(await store.listRuntimeResults(sessionId, "turn-1")).toHaveLength(
        0,
      );
      expect(await store.listToolCalls(sessionId)).toHaveLength(0);
      expect(await store.listStateSchemas(sessionId)).toHaveLength(0);
      expect(await store.listStateEntries(sessionId, "stats")).toHaveLength(0);
      expect(
        await store.listStateChanges(sessionId, "stats", "hp"),
      ).toHaveLength(0);
      expect(await store.listEvents(sessionId)).toHaveLength(0);
      expect(await store.listApprovals(sessionId)).toHaveLength(0);
      expect(await store.listMessages(sessionId)).toHaveLength(0);
      expect(await store.listCharacters(sessionId)).toHaveLength(0);
      expect(await store.getPluginConfig(sessionId, "narrator")).toBeNull();
      expect(await store.listTraceEvents(sessionId)).toHaveLength(0);
      expect(await store.listRuntimeOutputs(sessionId)).toHaveLength(0);
      expect(await store.listInteractionRecords(sessionId)).toHaveLength(0);
      expect(await store.listTurnMessages(sessionId)).toHaveLength(0);
      expect(await store.listPlayerInputs(sessionId)).toHaveLength(0);
      expect(await store.listWorkingMemory(sessionId)).toHaveLength(0);
      expect(await store.listWorldDataImportLedger(sessionId)).toHaveLength(0);
      expect(await store.listSessionLorebookEntries(sessionId)).toHaveLength(0);
      expect(await store.listSessionSummaries(sessionId)).toHaveLength(0);
      expect(await store.listSuspensions(sessionId)).toHaveLength(0);
      expect(await store.listSnapshots(sessionId)).toHaveLength(0);
      expect(await store.listPluginData(sessionId, "plugin-1")).toHaveLength(0);

      // Parallel session untouched.
      expect(await store.getSession(otherId)).not.toBeNull();
      expect(await store.listTurnResults(otherId)).toHaveLength(1);
      expect(await store.listSuspensions(otherId)).toHaveLength(1);
      expect(await store.listWorkingMemory(otherId)).toHaveLength(1);
      expect(await store.listSessionLorebookEntries(otherId)).toHaveLength(1);
    });
  });

  describe("transactions (S4-T1)", () => {
    it("rolls back all writes on rollbackTx", async () => {
      // Baseline — no sessions yet
      const before = await store.listSessions();
      const baselineIds = new Set(before.map((s) => s.id));

      const s1 = makeSession();
      const s2 = makeSession();

      await store.beginTx();
      await store.createSession(s1);
      await store.createSession(s2);
      await store.rollbackTx();

      const after = await store.listSessions();
      const afterIds = after.map((s) => s.id);
      expect(afterIds).not.toContain(s1.id);
      expect(afterIds).not.toContain(s2.id);
      // Rollback must not delete pre-existing rows either
      for (const id of baselineIds) {
        expect(afterIds).toContain(id);
      }
    });

    it("commits all writes on commitTx", async () => {
      const s1 = makeSession();
      const s2 = makeSession();

      await store.beginTx();
      await store.createSession(s1);
      await store.createSession(s2);
      await store.commitTx();

      const r1 = await store.getSession(s1.id);
      const r2 = await store.getSession(s2.id);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
    });

    it("throws on nested beginTx", async () => {
      await store.beginTx();
      try {
        await expect(store.beginTx()).rejects.toThrow();
      } finally {
        await store.rollbackTx();
      }
    });

    it("throws on commitTx without an active transaction", async () => {
      await expect(store.commitTx()).rejects.toThrow();
    });

    it("throws on rollbackTx without an active transaction", async () => {
      await expect(store.rollbackTx()).rejects.toThrow();
    });
  });

  describe("withTransaction (T12 scoped transactions)", () => {
    it("is implemented by every bundled backend", () => {
      expect(typeof store.withTransaction).toBe("function");
    });

    it("commits all writes when the callback resolves", async () => {
      const s1 = makeSession();
      const s2 = makeSession();

      await store.withTransaction!(async (tx) => {
        await tx.createSession(s1);
        await tx.createSession(s2);
      });

      expect(await store.getSession(s1.id)).not.toBeNull();
      expect(await store.getSession(s2.id)).not.toBeNull();
    });

    it("rolls back all writes and rethrows when the callback throws", async () => {
      const before = await store.listSessions();
      const baselineIds = new Set(before.map((s) => s.id));

      const s1 = makeSession();
      const s2 = makeSession();
      const boom = new Error("withTransaction boom");

      await expect(
        store.withTransaction!(async (tx) => {
          await tx.createSession(s1);
          await tx.createSession(s2);
          throw boom;
        }),
      ).rejects.toThrow("withTransaction boom");

      const after = await store.listSessions();
      const afterIds = after.map((s) => s.id);
      expect(afterIds).not.toContain(s1.id);
      expect(afterIds).not.toContain(s2.id);
      // Rollback must not delete pre-existing rows either.
      for (const keep of baselineIds) {
        expect(afterIds).toContain(keep);
      }
    });

    it("returns the callback result", async () => {
      const s1 = makeSession();
      const result = await store.withTransaction!(async (tx) => {
        await tx.createSession(s1);
        return 42;
      });
      expect(result).toBe(42);
    });

    it("does not swallow writes across concurrent transactions", async () => {
      // PG runs these on independent pooled connections (true concurrency);
      // single-connection backends serialize them. Either way, BOTH writes must
      // survive — proving no shared/global handle is clobbered mid-transaction.
      const s1 = makeSession();
      const s2 = makeSession();
      const s3 = makeSession();

      await Promise.all([
        store.withTransaction!(async (tx) => {
          await tx.createSession(s1);
        }),
        store.withTransaction!(async (tx) => {
          await tx.createSession(s2);
        }),
        store.withTransaction!(async (tx) => {
          await tx.createSession(s3);
        }),
      ]);

      expect(await store.getSession(s1.id)).not.toBeNull();
      expect(await store.getSession(s2.id)).not.toBeNull();
      expect(await store.getSession(s3.id)).not.toBeNull();
    });

    it("rolls back only the failing concurrent transaction", async () => {
      const ok = makeSession();
      const bad = makeSession();

      const results = await Promise.allSettled([
        store.withTransaction!(async (tx) => {
          await tx.createSession(ok);
        }),
        store.withTransaction!(async (tx) => {
          await tx.createSession(bad);
          throw new Error("only this one fails");
        }),
      ]);

      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("rejected");
      expect(await store.getSession(ok.id)).not.toBeNull();
      expect(await store.getSession(bad.id)).toBeNull();
    });
  });

  describe("Lifecycle", () => {
    it("should close without throwing", async () => {
      await expect(store.close()).resolves.not.toThrow();
    });
  });
}
