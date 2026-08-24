import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/memory/memory-store.js";
import type { PluginDataRecord } from "../src/types.js";

function row(key: string): PluginDataRecord {
  const now = new Date().toISOString();
  return {
    id: `session:plugin:namespace:${key}`,
    sessionId: "session",
    pluginId: "plugin",
    namespace: "namespace",
    key,
    value: { nested: { count: 1 } },
    createdAt: now,
    updatedAt: now,
  };
}

function mutateCount(record: PluginDataRecord, count: number): void {
  (record.value as { nested: { count: number } }).nested.count = count;
}

describe("MemoryStore value boundaries", () => {
  it("does not retain references to caller-owned write inputs", async () => {
    const store = createMemoryStore();
    const input = row("input");

    await store.setPluginData(input);
    mutateCount(input, 99);

    await expect(
      store.getPluginData("session", "plugin", "namespace", "input"),
    ).resolves.toMatchObject({ value: { nested: { count: 1 } } });
  });

  it("does not expose internal references from get or list results", async () => {
    const store = createMemoryStore();
    await store.setPluginData(row("output"));

    const fromGet = await store.getPluginData(
      "session",
      "plugin",
      "namespace",
      "output",
    );
    mutateCount(fromGet!, 50);
    const fromList = await store.listPluginData(
      "session",
      "plugin",
      "namespace",
    );
    mutateCount(fromList[0]!, 75);

    await expect(
      store.getPluginData("session", "plugin", "namespace", "output"),
    ).resolves.toMatchObject({ value: { nested: { count: 1 } } });
  });

  it("keeps the same isolation inside transaction scopes", async () => {
    const store = createMemoryStore();
    const input = row("transaction");

    await store.withTransaction!(async (tx) => {
      await tx.setPluginData(input);
      mutateCount(input, 20);
      const read = await tx.getPluginData(
        "session",
        "plugin",
        "namespace",
        "transaction",
      );
      expect(read).toMatchObject({ value: { nested: { count: 1 } } });
      mutateCount(read!, 30);
    });

    await expect(
      store.getPluginData("session", "plugin", "namespace", "transaction"),
    ).resolves.toMatchObject({ value: { nested: { count: 1 } } });
  });
});
