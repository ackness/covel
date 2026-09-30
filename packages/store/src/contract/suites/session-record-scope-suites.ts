import { describe, expect, it } from "vitest";
import { SessionRecordScopeConflictError } from "../../errors.js";
import type { DataStore, StoreTransaction } from "../../types.js";
import {
  makeSession,
  makeSnapshot,
  makeSuspension,
  makeWorldDataImportLedger,
} from "../test-fixtures.js";

function registerRecordScopeSuite<T extends { id: string; sessionId: string }>(
  recordType: string,
  getStore: () => DataStore,
  makeRecord: (id: string, sessionId: string) => T,
  updateRecord: (record: T) => T,
  save: (store: StoreTransaction, record: T) => Promise<void>,
  read: (store: DataStore, record: T) => Promise<T | null>,
): void {
  describe(`${recordType} id ownership`, () => {
    async function setup() {
      const store = getStore();
      await store.createSession(makeSession({ id: "scope-first" }));
      await store.createSession(makeSession({ id: "scope-second" }));
      return store;
    }

    it("preserves the original record when another session reuses its id", async () => {
      const store = await setup();
      const original = makeRecord("owned-id", "scope-first");
      await save(store, original);
      await expect(
        save(store, updateRecord({ ...original, sessionId: "scope-second" })),
      ).rejects.toMatchObject({
        name: "SessionRecordScopeConflictError",
        code: "session_record_scope_conflict",
        recordType,
        recordId: original.id,
      });
      expect(await read(store, original)).toEqual(original);
      expect(
        await read(store, { ...original, sessionId: "scope-second" }),
      ).toBeNull();
    });

    it("allows updates from the same session", async () => {
      const store = await setup();
      const original = makeRecord("owned-id", "scope-first");
      await save(store, original);
      const updated = updateRecord(original);
      await save(store, updated);
      expect(await read(store, original)).toEqual(updated);
    });

    it("admits exactly one owner when concurrent first inserts reuse an id", async () => {
      const store = await setup();
      const first = makeRecord("racing-id", "scope-first");
      const second = { ...updateRecord(first), sessionId: "scope-second" };
      const records = [first, second];
      const results = await Promise.allSettled(
        records.map((record) => save(store, record)),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const winner = results.findIndex(
        (result) => result.status === "fulfilled",
      );
      const loser = results[1 - winner];
      expect(loser).toMatchObject({
        status: "rejected",
        reason: {
          code: "session_record_scope_conflict",
          recordType,
          recordId: first.id,
        },
      });
      expect(await read(store, records[winner]!)).toEqual(records[winner]);
      expect(await read(store, records[1 - winner]!)).toBeNull();
    });

    it("rolls back earlier writes when a transaction encounters a scope conflict", async () => {
      const store = await setup();
      const original = makeRecord("owned-id", "scope-first");
      const pending = makeRecord("transaction-id", "scope-second");
      await save(store, original);
      await expect(
        store.withTransaction(async (tx) => {
          await save(tx, pending);
          await save(tx, { ...original, sessionId: "scope-second" });
        }),
      ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
      expect(await read(store, original)).toEqual(original);
      expect(await read(store, pending)).toBeNull();
    });
  });
}

export function registerSessionRecordScopeSuites(
  getStore: () => DataStore,
): void {
  registerRecordScopeSuite(
    "snapshot",
    getStore,
    (id, sessionId) => makeSnapshot({ id, sessionId }),
    (record) => ({ ...record, kind: "auto" as const }),
    (store, record) => store.saveSnapshot(record),
    async (store, record) => {
      const saved = await store.getSnapshot(record.id);
      return saved?.sessionId === record.sessionId ? saved : null;
    },
  );
  registerRecordScopeSuite(
    "suspension",
    getStore,
    (id, sessionId) => makeSuspension({ id, sessionId }),
    (record) => ({ ...record, reason: "Updated continuation" }),
    (store, record) => store.saveSuspension(record),
    async (store, record) => {
      const saved = await store.getSuspension(record.id);
      return saved?.sessionId === record.sessionId ? saved : null;
    },
  );
  registerRecordScopeSuite(
    "world-data import ledger",
    getStore,
    (id, sessionId) => makeWorldDataImportLedger({ id, sessionId }),
    (record) => ({ ...record, valueHash: "updated-value" }),
    (store, record) => store.saveWorldDataImportLedgerBatch([record]),
    async (store, record) =>
      (await store.listWorldDataImportLedger(record.sessionId)).find(
        (saved) => saved.id === record.id,
      ) ?? null,
  );

  describe("world-data import ledger atomic scope validation", () => {
    it("rolls back a batch's inserts and updates when a later row belongs to another session", async () => {
      const store = getStore();
      const original = makeWorldDataImportLedger({
        id: "original",
        sessionId: "first",
      });
      const owned = makeWorldDataImportLedger({
        id: "owned",
        sessionId: "second",
      });
      await store.saveWorldDataImportLedgerBatch([original, owned]);
      await expect(
        store.saveWorldDataImportLedgerBatch([
          { ...owned, valueHash: "changed" },
          { ...owned, id: "new" },
          { ...original, sessionId: "second" },
        ]),
      ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
      expect(await store.listWorldDataImportLedger("first")).toEqual([
        original,
      ]);
      expect(await store.listWorldDataImportLedger("second")).toEqual([owned]);
    });

    it("rejects conflicting duplicate ids within a new batch and permits same-session duplicates", async () => {
      const store = getStore();
      const first = makeWorldDataImportLedger({
        id: "duplicate",
        sessionId: "first",
      });
      await expect(
        store.saveWorldDataImportLedgerBatch([
          first,
          { ...first, sessionId: "second" },
        ]),
      ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
      expect(await store.listWorldDataImportLedger("first")).toEqual([]);
      expect(await store.listWorldDataImportLedger("second")).toEqual([]);
      const updated = { ...first, valueHash: "updated" };
      await store.saveWorldDataImportLedgerBatch([first, updated]);
      expect(await store.listWorldDataImportLedger("first")).toEqual([updated]);
    });
  });
}
