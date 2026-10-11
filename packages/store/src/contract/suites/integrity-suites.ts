import { beforeEach, describe, expect, it } from "vitest";
import { registerSessionRecordScopeSuites } from "./session-record-scope-suites.js";
import {
  SESSION_SCOPED_TABLES,
  type SessionScopedMemoryKey,
} from "../../table-registry.js";
import type { DataStore } from "../../types.js";
import { supportsVector } from "../../vector-store.js";
import {
  id,
  makeCharacter,
  makeEvent,
  makeInteractionRecord,
  makeJobStatus,
  makeLogicalTurnCompletion,
  makeLorebookEntry,
  makeMessage,
  makePlayerInput,
  makeRuntimeExport,
  makeRuntimeOutput,
  makeSession,
  makeSessionSummary,
  makeSetupAttempt,
  makeSnapshot,
  makeStateChange,
  makeStateEntry,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
  makeWorldDataImportLedger,
  ts,
} from "../test-fixtures.js";

/** Writes one row of a session-scoped kind and counts that kind's rows. */
interface CascadeProbe {
  /** "unsupported" when this backend cannot hold the kind. */
  seed(store: DataStore, sessionId: string): Promise<void | "unsupported">;
  count(store: DataStore, sessionId: string): Promise<number>;
}

const VECTOR_PROGRESS_SCOPE = { pluginId: "plugin-1", namespace: "recall" };

const CASCADE_PROBES: Readonly<Record<SessionScopedMemoryKey, CascadeProbe>> = {
  vectorIndexProgress: {
    async seed(store, sessionId) {
      if (!supportsVector(store)) return "unsupported";
      const session = await store.getSession(sessionId);
      await store.commitVectorIndexBatch({
        ...VECTOR_PROGRESS_SCOPE,
        sessionId,
        value: "progress",
        expectedValue: null,
        expectedSessionCreatedAt: session!.createdAt,
      });
      return undefined;
    },
    async count(store, sessionId) {
      if (!supportsVector(store)) return 0;
      const value = await store.getVectorIndexProgress({
        ...VECTOR_PROGRESS_SCOPE,
        sessionId,
      });
      return value === null ? 0 : 1;
    },
  },
  turnResults: {
    seed: (store, sessionId) =>
      store.saveTurnResult(makeTurnResult({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listTurnResults(sessionId)).length,
  },
  toolCalls: {
    seed: (store, sessionId) => store.saveToolCall(makeToolCall({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listToolCalls(sessionId)).length,
  },
  stateSchemas: {
    seed: (store, sessionId) =>
      store.saveStateSchema(makeStateSchema({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listStateSchemas(sessionId)).length,
  },
  stateEntries: {
    seed: (store, sessionId) =>
      store.upsertStateEntry(makeStateEntry({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listStateEntries(sessionId, makeStateEntry().tableName))
        .length,
  },
  stateChanges: {
    seed: (store, sessionId) =>
      store.addStateChange(makeStateChange({ sessionId })),
    count: async (store, sessionId) => {
      const { tableName, fieldName } = makeStateChange();
      return (await store.listStateChanges(sessionId, tableName, fieldName))
        .length;
    },
  },
  events: {
    seed: (store, sessionId) => store.saveEvent(makeEvent({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listEvents(sessionId)).length,
  },
  messages: {
    seed: (store, sessionId) => store.addMessage(makeMessage({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listMessages(sessionId)).length,
  },
  characterSchemas: {
    seed: (store, sessionId) =>
      store.upsertCharacterSchema({
        sessionId,
        version: 1,
        types: ["npc"],
        attributes: [],
        createdAt: ts(),
        updatedAt: ts(),
      }),
    count: async (store, sessionId) =>
      (await store.getCharacterSchema(sessionId)) === null ? 0 : 1,
  },
  characters: {
    seed: (store, sessionId) =>
      store.upsertCharacter(makeCharacter({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listCharacters(sessionId)).length,
  },
  pluginData: {
    seed: (store, sessionId) =>
      store.setPluginData({
        id: id(),
        sessionId,
        pluginId: "plugin-1",
        namespace: "ns",
        key: "k",
        value: { v: 1 },
        createdAt: ts(),
        updatedAt: ts(),
      }),
    count: async (store, sessionId) =>
      (await store.listPluginData(sessionId, "plugin-1")).length,
  },
  worldDataImportLedger: {
    seed: (store, sessionId) =>
      store.saveWorldDataImportLedgerBatch([
        makeWorldDataImportLedger({ sessionId }),
      ]),
    count: async (store, sessionId) =>
      (await store.listWorldDataImportLedger(sessionId)).length,
  },
  traceEvents: {
    seed: (store, sessionId) =>
      store.addTraceEvent(makeTraceEvent({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listTraceEvents(sessionId)).length,
  },
  runtimeOutputs: {
    seed: (store, sessionId) =>
      store.saveRuntimeOutput(makeRuntimeOutput({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listRuntimeOutputs(sessionId)).length,
  },
  interactionRecords: {
    seed: (store, sessionId) =>
      store.saveInteractionRecord(makeInteractionRecord({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listInteractionRecords(sessionId)).length,
  },
  turnMessages: {
    seed: (store, sessionId) =>
      store.appendTurnMessage(makeTurnMessage({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listTurnMessages(sessionId)).length,
  },
  playerInputs: {
    seed: (store, sessionId) =>
      store.savePlayerInput(makePlayerInput({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listPlayerInputs(sessionId)).length,
  },
  lorebookEntries: {
    seed: (store, sessionId) =>
      store.upsertLorebookEntries([makeLorebookEntry({ sessionId })]),
    count: async (store, sessionId) =>
      (await store.listSessionLorebookEntries(sessionId)).length,
  },
  sessionSummaries: {
    seed: (store, sessionId) =>
      store.saveSessionSummary(makeSessionSummary({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listSessionSummaries(sessionId)).length,
  },
  suspensions: {
    seed: (store, sessionId) =>
      store.saveSuspension(makeSuspension({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listSuspensions(sessionId)).length,
  },
  snapshots: {
    seed: (store, sessionId) => store.saveSnapshot(makeSnapshot({ sessionId })),
    count: async (store, sessionId) =>
      (await store.listSnapshots(sessionId)).length,
  },
  logicalTurnLedger: {
    seed: async (store, sessionId) => {
      await store.insertLogicalTurnCompletion(
        makeLogicalTurnCompletion({ sessionId }),
      );
    },
    count: async (store, sessionId) =>
      (await store.listLogicalTurnCompletions(sessionId)).length,
  },
  setupAttempts: {
    seed: async (store, sessionId) => {
      await store.insertSetupAttempt(makeSetupAttempt({ sessionId }));
    },
    count: async (store, sessionId) =>
      (await store.listSetupAttempts(sessionId)).length,
  },
  jobStatus: {
    seed: async (store, sessionId) => {
      await store.appendJobStatus(makeJobStatus({ sessionId }));
    },
    count: async (store, sessionId) =>
      (await store.listJobStatus(sessionId)).length,
  },
  runtimeExports: {
    seed: async (store, sessionId) => {
      await store.appendRuntimeExport(makeRuntimeExport({ sessionId }));
    },
    count: async (store, sessionId) =>
      (await store.listRuntimeExports(sessionId)).length,
  },
};

export function registerIntegrityStoreSuites(getStore: () => DataStore): void {
  registerSessionRecordScopeSuites(getStore);
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  describe("deleteSession cascade", () => {
    // One case per registered kind, generated from the registry: a kind added
    // to the registry without a probe in `CASCADE_PROBES` does not compile.
    it.each(
      SESSION_SCOPED_TABLES.map((entry) => [entry.table, entry] as const),
    )(
      "removes the session's %s rows and keeps another session's",
      async (_table, entry) => {
        const probe = CASCADE_PROBES[entry.memoryKey];
        const sessionId = `sess-cascade-${entry.table}`;
        const otherId = `sess-cascade-keep-${entry.table}`;
        await store.createSession(makeSession({ id: sessionId }));
        await store.createSession(makeSession({ id: otherId }));

        if ((await probe.seed(store, sessionId)) === "unsupported") return;
        await probe.seed(store, otherId);
        expect(await probe.count(store, sessionId)).toBe(1);
        expect(await probe.count(store, otherId)).toBe(1);

        await store.deleteSession(sessionId);

        expect(await store.getSession(sessionId)).toBeNull();
        expect(await probe.count(store, sessionId)).toBe(0);
        expect(await store.getSession(otherId)).not.toBeNull();
        expect(await probe.count(store, otherId)).toBe(1);
      },
    );
  });

  describe("withTransaction (scoped transactions)", () => {
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

    it("rolls back only a failed savepoint and keeps the enclosing transaction", async () => {
      const kept = makeSession();
      const dropped = makeSession();
      const nested = makeSession();
      const afterSavepoint = makeSession();

      await store.withTransaction!(async (tx) => {
        await tx.createSession(kept);
        await expect(
          tx.savepoint!(async (sp) => {
            await sp.createSession(dropped);
            await sp.savepoint!(async (inner) => {
              await inner.createSession(nested);
            });
            throw new Error("savepoint boom");
          }),
        ).rejects.toThrow("savepoint boom");
        await tx.savepoint!(async (sp) => {
          await sp.createSession(afterSavepoint);
        });
      });

      const ids = (await store.listSessions()).map((s) => s.id);
      expect(ids).toContain(kept.id);
      expect(ids).toContain(afterSavepoint.id);
      expect(ids).not.toContain(dropped.id);
      expect(ids).not.toContain(nested.id);
    });

    it("rolls back savepoint writes with the enclosing transaction", async () => {
      const inner = makeSession();
      await expect(
        store.withTransaction!(async (tx) => {
          await tx.savepoint!(async (sp) => {
            await sp.createSession(inner);
          });
          throw new Error("outer boom");
        }),
      ).rejects.toThrow("outer boom");
      expect(await store.getSession(inner.id)).toBeNull();
    });

    it("does not expose writes through the root store before the transaction settles", async () => {
      const pending = makeSession();
      let release!: () => void;
      let markWritten!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const written = new Promise<void>((resolve) => {
        markWritten = resolve;
      });

      const txPromise = store.withTransaction!(async (tx) => {
        await tx.createSession(pending);
        markWritten();
        await hold;
        throw new Error("visibility rollback");
      });
      await written;

      const readPromise = store.getSession(pending.id);
      const early = await Promise.race([
        readPromise.then((value) => ({ settled: true as const, value })),
        new Promise<{ settled: false }>((resolve) =>
          setTimeout(() => resolve({ settled: false }), 20),
        ),
      ]);

      release();
      await expect(txPromise).rejects.toThrow("visibility rollback");
      // PG may immediately return its committed snapshot (null); serialized
      // backends wait. Neither behavior may expose the in-flight row.
      if (early.settled) expect(early.value).toBeNull();
      await expect(readPromise).resolves.toBeNull();
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

    it("rejects a nested withTransaction with a clear error instead of deadlocking", async () => {
      // A withTransaction call issued from INSIDE another withTransaction
      // callback is a programming error: on the serialized backends it would
      // queue behind the outer transaction that is awaiting it (deadlock); on PG
      // it would run on an independent connection, not atomic with the outer.
      // Every backend must reject it synchronously rather than hang. `rejects`
      // (not a timeout) is what proves there is no deadlock.
      const outer = makeSession();
      const inner = makeSession();

      await expect(
        store.withTransaction!(async (tx) => {
          await tx.createSession(outer);
          await store.withTransaction!(async (innerTx) => {
            await innerTx.createSession(inner);
          });
        }),
      ).rejects.toThrow(/nested withTransaction is not supported/);

      // The nested rejection propagated out of the outer callback, so the outer
      // transaction rolled back and neither session was committed.
      expect(await store.getSession(outer.id)).toBeNull();
      expect(await store.getSession(inner.id)).toBeNull();
    });

    it("recovers and accepts a fresh withTransaction after a nested rejection", async () => {
      // Guard against the nesting rejection corrupting the serialization chain.
      await expect(
        store.withTransaction!(async () => {
          await store.withTransaction!(async () => {});
        }),
      ).rejects.toThrow(/nested withTransaction is not supported/);

      const after = makeSession();
      await store.withTransaction!(async (tx) => {
        await tx.createSession(after);
      });
      expect(await store.getSession(after.id)).not.toBeNull();
    });
  });

  describe("Lifecycle", () => {
    it("should close without throwing", async () => {
      await expect(store.close()).resolves.not.toThrow();
    });
  });
}
