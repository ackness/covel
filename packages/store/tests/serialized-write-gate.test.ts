/**
 * Single-connection backends must not let an unrelated write get folded into
 * an open transaction and lost when that transaction rolls back.
 *
 * Before the serialized write gate, `createMemoryStore()` / `createSqliteStore()`
 * shared one state / one connection: a write issued while a transaction was
 * mid-flight landed inside it. That is fine for writes belonging to the same
 * turn (they are ordered by the session lock), but a write from ANOTHER
 * session — or from a route holding no session lock at all — vanished on
 * rollback.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import type { DataStore } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSqliteStore(): DataStore {
  const dir = mkdtempSync(path.join(tmpdir(), "covel-write-gate-"));
  tempDirs.push(dir);
  return createSqliteStore(path.join(dir, "test.db"));
}

async function seedSession(store: DataStore, id: string): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: null,
    status: "active",
    presetId: null,
    activePlugins: [],
    turnCount: 0,
    preGameCompleted: [],
    createdAt: now,
    updatedAt: now,
  });
}

function pluginDataRow(sessionId: string, key: string) {
  const now = new Date().toISOString();
  return {
    id: `${sessionId}:p:ns:${key}`,
    sessionId,
    pluginId: "p",
    namespace: "ns",
    key,
    value: { v: key },
    createdAt: now,
    updatedAt: now,
  };
}

const backends: ReadonlyArray<[string, () => DataStore]> = [
  ["MemoryStore", () => createMemoryStore()],
  ["SqliteStore", makeSqliteStore],
];

describe.each(backends)("%s serialized write gate", (_name, makeStore) => {
  it("an outside write survives a concurrent transaction's rollback", async () => {
    const store = makeStore();
    await seedSession(store, "sess-tx");
    await seedSession(store, "sess-other");

    // The competing write must originate from a DIFFERENT async context —
    // that is what a concurrent HTTP request looks like, and it is how the
    // gate tells "another caller" from "this transaction's own write".
    // Calling it lexically inside the callback would inherit the
    // transaction's context and correctly run inline.
    let releaseTx!: () => void;
    const txHeldOpen = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });

    const txPromise = store.withTransaction!(async (tx) => {
      await tx.setPluginData(pluginDataRow("sess-tx", "inside"));
      await txHeldOpen;
      throw new Error("boom");
    });
    // Let the transaction reach its hold point before writing from outside.
    await Promise.resolve();

    const outsideWriteDone = store.setPluginData(
      pluginDataRow("sess-other", "outside"),
    );

    releaseTx();
    await expect(txPromise).rejects.toThrow("boom");
    await outsideWriteDone;

    // The transaction's own write rolled back…
    expect(
      await store.getPluginData("sess-tx", "p", "ns", "inside"),
    ).toBeFalsy();
    // …the unrelated session's write did not.
    const survived = await store.getPluginData(
      "sess-other",
      "p",
      "ns",
      "outside",
    );
    expect(survived).toBeDefined();
    expect(survived?.value).toEqual({ v: "outside" });

    await store.close?.();
  });

  it("writes issued inside the callback still belong to the transaction", async () => {
    const store = makeStore();
    await seedSession(store, "sess-tx");

    await expect(
      store.withTransaction!(async (tx) => {
        await tx.setPluginData(pluginDataRow("sess-tx", "a"));
        await tx.setPluginData(pluginDataRow("sess-tx", "b"));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await store.getPluginData("sess-tx", "p", "ns", "a")).toBeFalsy();
    expect(await store.getPluginData("sess-tx", "p", "ns", "b")).toBeFalsy();

    await store.close?.();
  });

  it("a committed transaction still persists, and queued writes land after", async () => {
    const store = makeStore();
    await seedSession(store, "sess-tx");
    await seedSession(store, "sess-other");

    let releaseTx!: () => void;
    const txHeldOpen = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const txPromise = store.withTransaction!(async (tx) => {
      await tx.setPluginData(pluginDataRow("sess-tx", "committed"));
      await txHeldOpen;
    });
    await Promise.resolve();

    const queued = store.setPluginData(pluginDataRow("sess-other", "queued"));
    releaseTx();
    await txPromise;
    await queued;

    expect(
      await store.getPluginData("sess-tx", "p", "ns", "committed"),
    ).toBeDefined();
    expect(
      await store.getPluginData("sess-other", "p", "ns", "queued"),
    ).toBeDefined();

    await store.close?.();
  });
});
