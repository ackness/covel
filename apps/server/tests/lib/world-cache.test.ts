import { describe, it, expect } from "vitest";
import { getCachedWorld, invalidateWorldCache } from "../../src/world-cache.js";
import type { DataStore, WorldRecord } from "@covel/store";

function mockStore() {
  let calls = 0;
  const store = {
    calls: () => calls,
    getWorld: async (id: string): Promise<WorldRecord | null> => {
      calls++;
      return { id, name: id, metadata: {} } as WorldRecord;
    },
  };
  return store as typeof store & Pick<DataStore, "getWorld">;
}

describe("getCachedWorld", () => {
  it("serves repeat reads of the same worldId from cache", async () => {
    invalidateWorldCache();
    const store = mockStore();
    await getCachedWorld(store, "w-cache-a");
    await getCachedWorld(store, "w-cache-a");
    expect(store.calls()).toBe(1); // second read served from cache
  });

  it("keys by worldId — distinct worlds are read separately", async () => {
    invalidateWorldCache();
    const store = mockStore();
    await getCachedWorld(store, "w-cache-b");
    await getCachedWorld(store, "w-cache-c");
    expect(store.calls()).toBe(2);
  });

  it("invalidateWorldCache(worldId) forces a re-read", async () => {
    invalidateWorldCache();
    const store = mockStore();
    await getCachedWorld(store, "w-cache-d");
    invalidateWorldCache("w-cache-d");
    await getCachedWorld(store, "w-cache-d");
    expect(store.calls()).toBe(2);
  });
});
