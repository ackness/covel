import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { makeSession, makeTurnMessage } from "../src/contract/test-fixtures.js";
import type { MemoryStore } from "../src/memory/memory-types.js";
import type { PluginDataRecord } from "../src/types.js";

/**
 * Regression coverage for audit 2026-06-04 finding H3: the transaction
 * snapshot switched from per-record `structuredClone` to shallow collection
 * copies. These tests lock in the correctness invariant that rollback restores
 * exact pre-tx membership across the trickiest mutation shapes:
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

    await store.beginTx();
    await store.appendTurnMessage(
      makeTurnMessage({ id: "tm-drop", sessionId: "sess-1", order: 1 }),
    );
    await store.setPluginData(pluginData({ key: "drop", value: { n: 2 } }));
    await store.setPluginData(pluginData({ key: "keep", value: { n: 99 } }));
    await store.rollbackTx();

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

    await store.beginTx();
    await store.deletePluginData("sess-1", "p1", "ns", "k1");
    await store.rollbackTx();

    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key).sort()).toEqual(["k1", "k2"]);
  });

  it("rolls back array-slot spread replacement (tagTurnMessagesCompacted)", async () => {
    await store.appendTurnMessage(
      makeTurnMessage({ id: "tm-1", sessionId: "sess-1", order: 0 }),
    );

    await store.beginTx();
    await store.tagTurnMessagesCompacted("sess-1", ["tm-1"], "summary-1");
    const tagged = await store.listTurnMessages("sess-1");
    expect(tagged[0]?.compactedAtTurnId).toBe("summary-1");
    await store.rollbackTx();

    const restored = await store.listTurnMessages("sess-1");
    expect(restored[0]?.compactedAtTurnId).toBeUndefined();
  });

  it("commit discards the snapshot and keeps writes", async () => {
    await store.beginTx();
    await store.setPluginData(pluginData({ key: "committed" }));
    await store.commitTx();

    const rows = await store.listPluginData("sess-1", "p1");
    expect(rows.map((r) => r.key)).toEqual(["committed"]);
  });

  it("a record read before the tx is not corrupted by a rolled-back write", async () => {
    await store.setPluginData(pluginData({ key: "k", value: { n: 1 } }));
    const before = (await store.listPluginData("sess-1", "p1"))[0];

    await store.beginTx();
    await store.setPluginData(pluginData({ key: "k", value: { n: 2 } }));
    await store.rollbackTx();

    // The pre-tx reference still reflects its original value (records are
    // replaced wholesale, never mutated in place).
    expect(before?.value).toEqual({ n: 1 });
  });
});
