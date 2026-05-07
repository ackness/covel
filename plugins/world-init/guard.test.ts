import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../packages/store/src/index.ts";
import guard from "./guard.js";

describe("world-init guard", () => {
  it("skips schema-only reuse and imports world dimensions for a fresh session", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();

    await store.upsertWorld({
      id: "cloudmere",
      name: "Cloudmere",
      description: "Test world",
      createdAt: now,
      metadata: {
        dimensions: {
          geography: { regions: ["云梦泽"] },
          factions: { groups: ["青萍宗"] },
          economy: { currencies: [{ name: "灵石" }] },
          powerSystem: { name: "境界", tiers: [{ name: "炼气" }] },
          socialStructure: { hierarchy: ["外门", "内门"] },
        },
      },
    });

    await store.createSession({
      id: "sess-prev-empty",
      worldId: "cloudmere",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });

    await store.setPluginData({
      id: "schema-prev",
      sessionId: "sess-prev-empty",
      pluginId: "world-init",
      namespace: "schema",
      key: "character-attributes",
      value: { version: 1, attributes: [{ id: "hp", type: "number" }] },
      createdAt: now,
      updatedAt: now,
    });

    await store.createSession({
      id: "sess-current",
      worldId: "cloudmere",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });

    const result = await guard({
      sessionId: "sess-current",
      turnId: "turn-1",
      pluginId: "world-init",
      playerMessage: "",
      locale: "zh-CN",
      store,
      completedResults: new Map(),
      config: {},
    });

    expect(result.skip).toBe(true);
    expect(result.importedDimensions).toBe(true);
    expect(result.reusedFrom).toBeUndefined();
    expect(result.entryCount).toBe(5);

    const importedEntries = await store.listPluginData(
      "sess-current",
      "world-init",
      "entries",
    );
    expect(importedEntries).toHaveLength(5);
  });
});
