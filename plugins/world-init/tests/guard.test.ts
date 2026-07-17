import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../../../packages/store/src/index.ts";
import guard from "../guard.js";

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

  it("writes world-declared characterAttributes verbatim, overriding a reusable older session's schema", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();

    const declared = [
      {
        id: "club",
        name: { "zh-CN": "社团", "en-US": "Club" },
        type: "string",
        category: "social",
      },
      {
        id: "affection",
        name: { "zh-CN": "好感度", "en-US": "Affection" },
        type: "number",
        min: 0,
        max: 100,
        category: "social",
      },
    ];

    await store.upsertWorld({
      id: "haruka-test",
      name: "Haruka",
      description: "Declared-attributes world",
      createdAt: now,
      metadata: {
        dimensions: { geography: { regions: ["海边小镇"] } },
        characterAttributes: declared,
      },
    });

    // A previous session with BOTH a stale schema AND entries — this would be
    // reused by path 2b if the declared schema were not authoritative.
    await store.createSession({
      id: "sess-old",
      worldId: "haruka-test",
      status: "active",
      turnCount: 5,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: "schema-old",
      sessionId: "sess-old",
      pluginId: "world-init",
      namespace: "schema",
      key: "character-attributes",
      value: { version: 1, attributes: [{ id: "hp", type: "number" }] },
      createdAt: now,
      updatedAt: now,
    });
    await store.setPluginData({
      id: "entry-old",
      sessionId: "sess-old",
      pluginId: "world-init",
      namespace: "entries",
      key: "geography",
      value: { regions: ["旧数据"] },
      createdAt: now,
      updatedAt: now,
    });

    await store.createSession({
      id: "sess-new",
      worldId: "haruka-test",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });

    const result = await guard({
      sessionId: "sess-new",
      turnId: "turn-1",
      pluginId: "world-init",
      playerMessage: "",
      locale: "zh-CN",
      store,
      completedResults: new Map(),
    });

    expect(result.skip).toBe(true);
    expect(result.preGameDone).toBe(true);
    // Did NOT fall through to cross-session reuse.
    expect(result.reusedFrom).toBeUndefined();
    expect(result.schemaCount).toBe(2);

    const written = await store.listPluginData(
      "sess-new",
      "world-init",
      "schema",
    );
    expect(written).toHaveLength(1);
    const attrs = (written[0].value as { attributes: Array<{ id: string }> })
      .attributes;
    // Verbatim declared attributes — not the stale `hp` schema, not derived.
    expect(attrs.map((a) => a.id)).toEqual(["club", "affection"]);
    expect(attrs[0].name).toEqual({ "zh-CN": "社团", "en-US": "Club" });
  });
});
