import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import type { DataStore, PluginDataBatchCasEntry } from "../src/types.js";

const at = "2026-10-01T00:00:00.000Z";
const entry = (
  key: string,
  expectedVersion: number | null,
  version: number,
  value: number,
): PluginDataBatchCasEntry => ({
  namespace: "_dimensions",
  key,
  expectedVersion,
  value: { version, value },
  timestamp: at,
});

for (const [name, create] of [
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const) {
  describe(`plugin-data batch CAS: ${name}`, () => {
    let store: DataStore;
    beforeEach(() => {
      store = create();
    });
    afterEach(async () => {
      await store.close();
    });
    const read = async (key: string) =>
      (await store.getPluginData("s", "owner", "_dimensions", key))?.value;

    it("creates absent records once and rejects a batch without partial writes", async () => {
      expect(
        await store.compareAndSetPluginDataBatch("s", "owner", [
          entry("a", null, 1, 10),
          entry("b", null, 1, 20),
        ]),
      ).toBe(true);
      expect(
        await store.compareAndSetPluginDataBatch("s", "owner", [
          entry("a", 1, 2, 11),
          entry("b", 9, 2, 21),
        ]),
      ).toBe(false);
      expect(await read("a")).toEqual({ version: 1, value: 10 });
      expect(await read("b")).toEqual({ version: 1, value: 20 });
      expect(
        await store.compareAndSetPluginDataBatch("s", "owner", [
          entry("new", null, 1, 1),
          entry("a", null, 1, 1),
        ]),
      ).toBe(false);
      expect(await read("new")).toBeUndefined();
    });

    it("allows one winner for concurrent writers on the same version", async () => {
      await store.compareAndSetPluginDataBatch("s", "owner", [
        entry("a", null, 1, 10),
      ]);
      const outcomes = await Promise.all([
        store.compareAndSetPluginDataBatch("s", "owner", [
          entry("a", 1, 2, 11),
        ]),
        store.compareAndSetPluginDataBatch("s", "owner", [
          entry("a", 1, 2, 12),
        ]),
      ]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(await read("a")).toMatchObject({ version: 2 });
    });

    it("joins existing transactions and rolls back values and receipts together", async () => {
      await store.compareAndSetPluginDataBatch("s", "owner", [
        entry("a", null, 1, 10),
      ]);
      await expect(
        store.withTransaction(async (tx) => {
          expect(
            await tx.compareAndSetPluginDataBatch("s", "owner", [
              entry("a", 1, 2, 11),
              {
                ...entry("source", null, 1, 0),
                namespace: "_dimension-settlements",
              },
            ]),
          ).toBe(true);
          throw new Error("injected failure");
        }),
      ).rejects.toThrow("injected failure");
      expect(await read("a")).toEqual({ version: 1, value: 10 });
      expect(
        await store.getPluginData(
          "s",
          "owner",
          "_dimension-settlements",
          "source",
        ),
      ).toBeNull();
    });

    it("rejects duplicate comparisons before writing and isolates owners/sessions", async () => {
      await expect(
        store.compareAndSetPluginDataBatch("s", "owner", [
          entry("a", null, 1, 1),
          entry("a", null, 1, 2),
        ]),
      ).rejects.toThrow("duplicate");
      expect(await read("a")).toBeUndefined();
      await store.compareAndSetPluginDataBatch("other", "owner", [
        entry("a", null, 1, 1),
      ]);
      await store.compareAndSetPluginDataBatch("s", "other", [
        entry("a", null, 1, 2),
      ]);
      expect(await read("a")).toBeUndefined();
    });
  });
}
