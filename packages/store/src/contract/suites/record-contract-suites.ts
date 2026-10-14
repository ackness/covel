import { beforeEach, describe, expect, it } from "vitest";
import { RootStoreWriteInTransactionError } from "../../errors.js";
import type { DataStore } from "../../types.js";
import {
  makeEvent,
  makeInteractionRecord,
  makeLorebookEntry,
  makePlayerInput,
  makeRuntimeOutput,
  makeSession,
  makeSessionSummary,
  makeSnapshot,
  makeStateChange,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
} from "../test-fixtures.js";

const SESSION = "sess-record-contract";
const SAME_TIME = "2026-03-03T03:03:03.003Z";

/** Writes one append-only record twice under one `id` and counts the rows. */
interface AppendProbe {
  write(store: DataStore, id: string, revision: number): Promise<void>;
  count(store: DataStore): Promise<number>;
}

const APPEND_PROBES: Readonly<Record<string, AppendProbe>> = {
  saveTurnResult: {
    write: (store, id, revision) =>
      store.saveTurnResult(
        makeTurnResult({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => (await store.listTurnResults(SESSION)).length,
  },
  saveToolCall: {
    write: (store, id, revision) =>
      store.saveToolCall(
        makeToolCall({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => (await store.listToolCalls(SESSION)).length,
  },
  saveRuntimeOutput: {
    write: (store, id, revision) =>
      store.saveRuntimeOutput(
        makeRuntimeOutput({
          id,
          sessionId: SESSION,
          turnId: `turn-${revision}`,
        }),
      ),
    count: async (store) => (await store.listRuntimeOutputs(SESSION)).length,
  },
  saveInteractionRecord: {
    write: (store, id, revision) =>
      store.saveInteractionRecord(
        makeInteractionRecord({
          id,
          sessionId: SESSION,
          turnId: `turn-${revision}`,
        }),
      ),
    count: async (store) =>
      (await store.listInteractionRecords(SESSION)).length,
  },
  addStateChange: {
    write: (store, id, revision) =>
      store.addStateChange(
        makeStateChange({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => {
      const { tableName, fieldName } = makeStateChange();
      return (await store.listStateChanges(SESSION, tableName, fieldName))
        .length;
    },
  },
  saveEvent: {
    write: (store, id, revision) =>
      store.saveEvent(
        makeEvent({ id, sessionId: SESSION, topic: `topic-${revision}` }),
      ),
    count: async (store) => (await store.listEvents(SESSION)).length,
  },
  addTraceEvent: {
    write: (store, id, revision) =>
      store.addTraceEvent(
        makeTraceEvent({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => (await store.listTraceEvents(SESSION)).length,
  },
  savePlayerInput: {
    write: (store, id, revision) =>
      store.savePlayerInput(
        makePlayerInput({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => (await store.listPlayerInputs(SESSION)).length,
  },
  saveSessionSummary: {
    write: (store, id, revision) =>
      store.saveSessionSummary(
        makeSessionSummary({
          id,
          sessionId: SESSION,
          content: `summary ${revision}`,
        }),
      ),
    count: async (store) => (await store.listSessionSummaries(SESSION)).length,
  },
  appendTurnMessage: {
    write: (store, id, revision) =>
      store.appendTurnMessage(
        makeTurnMessage({ id, sessionId: SESSION, turnId: `turn-${revision}` }),
      ),
    count: async (store) => (await store.listTurnMessages(SESSION)).length,
  },
};

/**
 * Cross-backend rules for records that every backend must apply the same way:
 * global record identity, a total order for list methods, the transaction
 * boundary and atomic batches.
 */
export function registerRecordContractSuites(getStore: () => DataStore): void {
  describe("Record contract", () => {
    registerRecordContractTests(getStore);
  });
}

function registerRecordContractTests(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(async () => {
    store = getStore();
    await store.createSession(makeSession({ id: SESSION }));
  });

  describe("Append-only record identity", () => {
    it.each(Object.keys(APPEND_PROBES))(
      "%s rejects a second record under one id and keeps the first",
      async (method) => {
        const probe = APPEND_PROBES[method]!;
        await probe.write(store, `${method}-dup`, 1);
        await expect(probe.write(store, `${method}-dup`, 2)).rejects.toThrow();
        expect(await probe.count(store)).toBe(1);
        // The rejected id stays taken only by the first record: a new id works.
        await probe.write(store, `${method}-fresh`, 3);
        expect(await probe.count(store)).toBe(2);
      },
    );
  });

  describe("List total order", () => {
    it("lists events of one millisecond by id, before and after a limit", async () => {
      for (const id of ["evt-b", "evt-a", "evt-c"])
        await store.saveEvent(
          makeEvent({ id, sessionId: SESSION, createdAt: SAME_TIME }),
        );
      expect((await store.listEvents(SESSION)).map((e) => e.id)).toEqual([
        "evt-a",
        "evt-b",
        "evt-c",
      ]);
      expect(
        (await store.listEvents(SESSION, { limit: 1 })).map((e) => e.id),
      ).toEqual(["evt-a"]);
    });

    it("lists state changes of one millisecond by id", async () => {
      for (const id of ["chg-b", "chg-a"])
        await store.addStateChange(
          makeStateChange({ id, sessionId: SESSION, createdAt: SAME_TIME }),
        );
      const { tableName, fieldName } = makeStateChange();
      expect(
        (await store.listStateChanges(SESSION, tableName, fieldName)).map(
          (c) => c.id,
        ),
      ).toEqual(["chg-a", "chg-b"]);
    });

    it("lists interaction records of one timestamp newest id first, before and after a limit", async () => {
      for (const id of ["ir-a", "ir-c", "ir-b"])
        await store.saveInteractionRecord(
          makeInteractionRecord({
            id,
            sessionId: SESSION,
            timestamp: SAME_TIME,
          }),
        );
      expect(
        (await store.listInteractionRecords(SESSION)).map((r) => r.id),
      ).toEqual(["ir-c", "ir-b", "ir-a"]);
      expect(
        (await store.listInteractionRecords(SESSION, { limit: 1 })).map(
          (r) => r.id,
        ),
      ).toEqual(["ir-c"]);
    });

    it("lists state schemas by table name, and an update does not move a row", async () => {
      const later = makeStateSchema({
        id: "schema-1",
        sessionId: SESSION,
        tableName: "table-b",
      });
      await store.saveStateSchema(later);
      await store.saveStateSchema(
        makeStateSchema({
          id: "schema-2",
          sessionId: SESSION,
          tableName: "table-a",
        }),
      );
      await store.saveStateSchema({ ...later });
      expect(
        (await store.listStateSchemas(SESSION)).map((s) => s.tableName),
      ).toEqual(["table-a", "table-b"]);
    });

    it("lists snapshots of one millisecond by id", async () => {
      for (const id of ["snap-b", "snap-a"])
        await store.saveSnapshot(
          makeSnapshot({ id, sessionId: SESSION, createdAt: SAME_TIME }),
        );
      expect((await store.listSnapshots(SESSION)).map((s) => s.id)).toEqual([
        "snap-a",
        "snap-b",
      ]);
    });

    it("lists suspensions and expired suspensions of one millisecond by id", async () => {
      for (const id of ["susp-b", "susp-a"])
        await store.saveSuspension(
          makeSuspension({ id, sessionId: SESSION, createdAt: SAME_TIME }),
        );
      expect((await store.listSuspensions(SESSION)).map((s) => s.id)).toEqual([
        "susp-a",
        "susp-b",
      ]);
      expect(
        (await store.listExpiredSuspensions("2027-01-01T00:00:00.000Z")).map(
          (s) => s.id,
        ),
      ).toEqual(["susp-a", "susp-b"]);
    });
  });

  describe("Root-store writes inside a transaction", () => {
    it("refuses a root write inside the callback and rolls the transaction back", async () => {
      const viaTx = makeSession();
      const viaRoot = makeSession();
      await expect(
        store.withTransaction(async (tx) => {
          await tx.createSession(viaTx);
          await store.createSession(viaRoot);
        }),
      ).rejects.toThrow(RootStoreWriteInTransactionError);
      expect(await store.getSession(viaTx.id)).toBeNull();
      expect(await store.getSession(viaRoot.id)).toBeNull();
    });

    it("writes nothing for a refused root write, even when the callback catches it", async () => {
      const viaTx = makeSession();
      const viaRoot = makeSession();
      let refused: unknown;
      await store.withTransaction(async (tx) => {
        refused = await store.createSession(viaRoot).catch((error) => error);
        await tx.createSession(viaTx);
      });
      expect(refused).toBeInstanceOf(RootStoreWriteInTransactionError);
      expect(await store.getSession(viaRoot.id)).toBeNull();
      expect(await store.getSession(viaTx.id)).not.toBeNull();
    });

    it("accepts a root write from a caller outside the callback while the transaction is open", async () => {
      const inside = makeSession();
      const outside = makeSession();
      let release!: () => void;
      let markOpen!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const open = new Promise<void>((resolve) => {
        markOpen = resolve;
      });
      const transaction = store.withTransaction(async (tx) => {
        await tx.createSession(inside);
        markOpen();
        await hold;
      });
      await open;
      const rootWrite = store.createSession(outside);
      release();
      await Promise.all([transaction, rootWrite]);
      expect(await store.getSession(inside.id)).not.toBeNull();
      expect(await store.getSession(outside.id)).not.toBeNull();
    });

    it("accepts a root write that the callback deferred until after the transaction settled", async () => {
      const later = makeSession();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let deferred!: Promise<void>;
      await store.withTransaction(async () => {
        deferred = settled.then(() => store.createSession(later));
      });
      settle();
      await deferred;
      expect(await store.getSession(later.id)).not.toBeNull();
    });
  });

  describe("Lorebook batch atomicity", () => {
    it("writes no entry of a batch when a later entry is rejected", async () => {
      const first = makeLorebookEntry({ id: "lore-ok", sessionId: SESSION });
      const second = makeLorebookEntry({
        id: "lore-\u0000bad",
        sessionId: SESSION,
      });
      await expect(
        store.upsertLorebookEntries([first, second]),
      ).rejects.toThrow();
      expect(await store.listSessionLorebookEntries(SESSION)).toEqual([]);
    });
  });
}
