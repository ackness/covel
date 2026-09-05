import { describe, expect, it } from "vitest";
import { SessionRecordScopeConflictError } from "../src/index.js";
import {
  makeSnapshot,
  makeSuspension,
  makeWorldDataImportLedger,
} from "../src/contract/test-fixtures.js";
import { createMemoryStore } from "../src/memory/memory-store.js";

describe("MemoryStore global record id ownership", () => {
  it("rejects a snapshot id owned by another session and preserves its payload", async () => {
    const store = createMemoryStore();
    const original = makeSnapshot({ id: "shared-id", sessionId: "original" });
    await store.saveSnapshot(original);

    await expect(
      store.saveSnapshot({ ...original, sessionId: "attacker", kind: "auto" }),
    ).rejects.toMatchObject({
      name: "SessionRecordScopeConflictError",
      code: "session_record_scope_conflict",
      recordType: "snapshot",
      recordId: original.id,
    });
    expect(await store.getSnapshot(original.id)).toEqual(original);
    expect(await store.listSnapshots("attacker")).toEqual([]);

    const updated = { ...original, kind: "auto" as const };
    await store.saveSnapshot(updated);
    expect(await store.getSnapshot(original.id)).toEqual(updated);
  });

  it("rejects a suspension id owned by another session and preserves its continuation", async () => {
    const store = createMemoryStore();
    const original = makeSuspension({ id: "shared-id", sessionId: "original" });
    await store.saveSuspension(original);

    await expect(
      store.saveSuspension({
        ...original,
        sessionId: "attacker",
        reason: "replaced",
      }),
    ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
    expect(await store.getSuspension(original.id)).toEqual(original);
    expect(await store.listSuspensions("attacker")).toEqual([]);

    const updated = { ...original, reason: "updated by original session" };
    await store.saveSuspension(updated);
    expect(await store.getSuspension(original.id)).toEqual(updated);
  });

  it("rejects the entire ledger batch when a later id belongs to another session", async () => {
    const store = createMemoryStore();
    const original = makeWorldDataImportLedger({
      id: "original-id",
      sessionId: "original",
    });
    const owned = makeWorldDataImportLedger({
      id: "owned-id",
      sessionId: "attacker",
    });
    await store.saveWorldDataImportLedgerBatch([original, owned]);
    await expect(
      store.saveWorldDataImportLedgerBatch([
        { ...owned, valueHash: "changed" },
        { ...owned, id: "new-id" },
        { ...original, sessionId: "attacker", valueHash: "replaced" },
      ]),
    ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
    expect(await store.listWorldDataImportLedger("original")).toEqual([
      original,
    ]);
    expect(await store.listWorldDataImportLedger("attacker")).toEqual([owned]);
  });

  it("rejects a new ledger id reused across sessions within the same batch", async () => {
    const store = createMemoryStore();
    const first = makeWorldDataImportLedger({
      id: "shared-id",
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
  });

  it("allows ledger updates and duplicate ids when their session is unchanged", async () => {
    const store = createMemoryStore();
    const original = makeWorldDataImportLedger({
      id: "owned-id",
      sessionId: "owner",
    });
    await store.saveWorldDataImportLedgerBatch([original]);
    const updated = { ...original, valueHash: "updated" };
    await store.saveWorldDataImportLedgerBatch([
      { ...original, valueHash: "intermediate" },
      updated,
    ]);
    expect(await store.listWorldDataImportLedger("owner")).toEqual([updated]);
  });

  it("rolls back earlier transaction writes when a global record id conflicts", async () => {
    const store = createMemoryStore();
    const original = makeSnapshot({ id: "shared-id", sessionId: "original" });
    await store.saveSnapshot(original);
    await expect(
      store.withTransaction!(async (tx) => {
        await tx.saveSuspension(
          makeSuspension({ id: "new-suspension", sessionId: "attacker" }),
        );
        await tx.saveSnapshot({ ...original, sessionId: "attacker" });
      }),
    ).rejects.toBeInstanceOf(SessionRecordScopeConflictError);
    expect(await store.getSnapshot(original.id)).toEqual(original);
    expect(await store.getSuspension("new-suspension")).toBeNull();
  });
});
