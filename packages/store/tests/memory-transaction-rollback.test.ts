import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { makeSession, makeTurnMessage } from "../src/contract/test-fixtures.js";
import type { MemoryStore } from "../src/memory/memory-types.js";
import type { PluginDataRecord } from "../src/types.js";

/**
 * Regression coverage for audit 2026-06-04 finding H3: the transaction
 * snapshot switched from per-record `structuredClone` to shallow collection
 * copies. These tests lock in the correctness invariant that a rolled-back
 * `withTransaction` restores exact pre-tx membership across the trickiest
 * mutation shapes:
 *   - array append (appendTurnMessage)
 *   - Map upsert + delete (setPluginData / deletePluginData)
 *   - array-slot spread replacement (tagTurnMessagesCompacted)
 * and that records read before the tx are never corrupted by a rolled-back
 * write.
 */
function pluginData(overrides: Partial<PluginDataRecord>): PluginDataRecord {
  return {
    id: `pd-${overrides.key ?? "k"}`,
    sessionId: "sess-1",
    pluginId: "p1",
    namespace: "ns",
    key: "k",
    value: { n: 1 },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryStore transaction rollback (H3 shallow snapshot)", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.createSession(makeSession({ id: "sess-1" }));
  });

  it("rolls back array appends and Map upserts to exact pre-tx state", async () => {
    await store.appendTurnMessage(
      makeTurnMessage({ id: "tm-keep", sessionId: "sess-1", order: 0 }),
    );
    await store.setPluginData(pluginData({ key: "keep", value: { n: 1 } }));

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.appendTurnMessage(
          makeTurnMessage({ id: "tm-drop", sessionId: "sess-1", order: 1 }),
        );
        await tx.setPluginData(pluginData({ key: "drop", value: { n: 2 } }));
        await tx.setPluginData(pluginData({ key: "keep", value: { n: 99 } }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const messages = await store.listTurnMessages("sess-1");
    expect(messages.map((m) => m.id)).toEqual(["tm-keep"]);

    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key).sort()).toEqual(["keep"]);
    const kept = rows.find((r) => r.key === "keep");
    expect(kept?.value).toEqual({ n: 1 });
  });

  it("rolls back deletions made inside the transaction", async () => {
    await store.setPluginData(pluginData({ key: "k1" }));
    await store.setPluginData(pluginData({ key: "k2" }));

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.deletePluginData("sess-1", "p1", "ns", "k1");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key).sort()).toEqual(["k1", "k2"]);
  });

  it("rolls back array-slot spread replacement (tagTurnMessagesCompacted)", async () => {
    await store.appendTurnMessage(
      makeTurnMessage({ id: "tm-1", sessionId: "sess-1", order: 0 }),
    );

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.tagTurnMessagesCompacted("sess-1", ["tm-1"], "summary-1");
        const tagged = await tx.listTurnMessages("sess-1");
        expect(tagged[0]?.compactedAtTurnId).toBe("summary-1");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const restored = await store.listTurnMessages("sess-1");
    expect(restored[0]?.compactedAtTurnId).toBeUndefined();
  });

  it("commit keeps writes when the callback resolves", async () => {
    await store.withTransaction!(async (tx) => {
      await tx.setPluginData(pluginData({ key: "committed" }));
    });

    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key)).toEqual(["committed"]);
  });

  it("snapshots only touched collections: a concurrent write to an untouched collection survives rollback (R-16)", async () => {
    // Pre-R-16 the eager whole-store snapshot would roll this concurrent
    // pluginData write back together with the failed tx. Touched-only capture
    // leaves untouched collections alone.
    await expect(
      store.withTransaction!(async (tx) => {
        await tx.appendTurnMessage(
          makeTurnMessage({ id: "tm-drop", sessionId: "sess-1", order: 0 }),
        );
        // Concurrent non-transaction write to a collection the tx never touches.
        await store.setPluginData(pluginData({ key: "survivor" }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await store.listTurnMessages("sess-1")).toHaveLength(0);
    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key)).toEqual(["survivor"]);
  });

  it("deleteSession inside a tx rolls back every cascaded collection", async () => {
    await store.appendTurnMessage(
      makeTurnMessage({ id: "tm-keep", sessionId: "sess-1", order: 0 }),
    );
    await store.setPluginData(pluginData({ key: "keep" }));

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.deleteSession("sess-1");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await store.getSession("sess-1")).not.toBeNull();
    expect(await store.listTurnMessages("sess-1")).toHaveLength(1);
    expect(await store.listPluginData("sess-1", "p1")).toHaveLength(1);
  });

  it("every WRITE_METHOD_TOUCHES key names a real store method", async () => {
    const { WRITE_METHOD_TOUCHES } =
      await import("../src/memory/transaction-methods.js");
    for (const name of Object.keys(WRITE_METHOD_TOUCHES)) {
      expect(
        typeof (store as unknown as Record<string, unknown>)[name],
        `WRITE_METHOD_TOUCHES maps unknown method "${name}"`,
      ).toBe("function");
    }
  });

  it("a record read before the tx is not corrupted by a rolled-back write", async () => {
    await store.setPluginData(pluginData({ key: "k", value: { n: 1 } }));
    const before = (await store.listPluginData("sess-1", "p1"))[0];

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.setPluginData(pluginData({ key: "k", value: { n: 2 } }));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    // The pre-tx reference still reflects its original value (records are
    // replaced wholesale, never mutated in place).
    expect(before?.value).toEqual({ n: 1 });
  });
});
