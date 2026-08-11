import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store";
import type {
  DataStore,
  CharacterRecord,
  LorebookEntryRecord,
  PlayerInputRecord,
  PluginDataRecord,
  SessionRecord,
  WorkingMemoryRecord,
  WorldRecord,
} from "@covel/store";
import { buildSessionContextSnapshot } from "@covel/context";

// ── Helpers ─────────────────────────────────────────────────────

function ts(offsetMs = 0): string {
  return new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + offsetMs,
  ).toISOString();
}

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: "sess-1",
    worldId: "w1",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: "w1",
    name: "W",
    description: "d",
    lore: "The land of Ash",
    metadata: {
      dimensions: {
        tone: "noir",
        startingConditions: { openingScenario: "You wake in a cell" },
      },
    },
    createdAt: ts(),
    ...overrides,
  };
}

function makeCharacter(overrides?: Partial<CharacterRecord>): CharacterRecord {
  return {
    id: "char-1",
    sessionId: "sess-1",
    name: "Hero",
    type: "player",
    version: 1,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makePluginData(
  overrides: Partial<PluginDataRecord> & { key: string },
): PluginDataRecord {
  return {
    id: `pd-${overrides.namespace ?? "ns"}-${overrides.key}`,
    sessionId: "sess-1",
    pluginId: "world-data",
    namespace: "schema",
    value: {},
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeLorebookEntry(
  overrides: Partial<LorebookEntryRecord> & { id: string },
): LorebookEntryRecord {
  return {
    sessionId: "sess-1",
    pluginId: "world-data",
    keys: [],
    content: "lorebook content",
    strategy: "constant",
    position: "after_char_defs",
    insertionOrder: 100,
    enabled: true,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeWorkingMemory(
  overrides: Partial<WorkingMemoryRecord> & { id: string },
): WorkingMemoryRecord {
  return {
    sessionId: "sess-1",
    key: "foo",
    scope: "shared",
    value: "bar",
    updatedAt: ts(),
    ...overrides,
  };
}

function makePlayerInput(
  overrides: Partial<PlayerInputRecord> & { id: string },
): PlayerInputRecord {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    formId: "f1",
    values: { name: "test" },
    createdAt: ts(),
    ...overrides,
  };
}

// ── Test A: Basic shape ─────────────────────────────────────────

describe("buildSessionContextSnapshot — basic shape", () => {
  it("returns a fully-shaped snapshot with empty defaults for an empty store", async () => {
    const store = createMemoryStore();
    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "en-US",
      turnNumber: 0,
    });

    // Top-level shape
    expect(snapshot.sessionId).toBe("sess-1");
    expect(snapshot.turnNumber).toBe(0);
    expect(snapshot.locale).toBe("en-US");
    expect(snapshot.sessionMeta).toBeDefined();
    expect(snapshot.sessionMeta.turnNumber).toBe(0);
    expect(snapshot.sessionMeta.lastFormValues).toBeUndefined();

    expect(snapshot.world).toBeDefined();
    expect(snapshot.world.id).toBe("");

    expect(snapshot.characters).toEqual([]);
    expect(snapshot.workingMemory).toEqual([]);
    expect(snapshot.coreMemoryBlocks).toEqual([]);
    expect(snapshot.loreEntries).toEqual([]);
    expect(snapshot.summaries).toEqual([]);
    expect(snapshot.contributions).toEqual([]);
    expect(snapshot.activePersona).toBeUndefined();

    expect(snapshot.world.schema).toBeUndefined();
    expect(snapshot.world.entries).toEqual([]);
  });
});

// ── Test B: Structured world context ────────────────────────────

describe("buildSessionContextSnapshot — world context", () => {
  it("uses the session lore override on every context rebuild", async () => {
    const store = createMemoryStore();
    await store.upsertWorld(makeWorld({ lore: "Original lore" }));
    await store.createSession(
      makeSession({ metadata: { loreOverride: "Player-edited lore" } }),
    );

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 1,
      worldId: "w1",
    });

    expect(snapshot.world.lore).toBe("Player-edited lore");
  });

  it("loads world metadata, schema, and lorebook entries into world.*", async () => {
    const store = createMemoryStore();
    const world = makeWorld();
    await store.upsertWorld(world);

    const session = makeSession();
    await store.createSession(session);

    // Plugin data — schema namespace (always used)
    await store.setPluginData(
      makePluginData({
        namespace: "schema",
        key: "dimensions",
        value: { tone: "noir" },
      }),
    );
    await store.setPluginData(
      makePluginData({
        namespace: "schema",
        key: "startingConditions",
        value: { openingScenario: "X" },
      }),
    );

    await store.upsertLorebookEntries([
      makeLorebookEntry({
        id: "lore-a",
        insertionOrder: 50,
        keys: ["alpha"],
        content: "Alpha content",
      }),
      makeLorebookEntry({
        id: "lore-b",
        insertionOrder: 100,
        keys: ["beta"],
        content: "Beta content",
      }),
    ]);

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 0,
      worldId: "w1",
      worldDataPluginId: "world-data",
    });

    expect(snapshot.world.id).toBe("w1");
    expect(snapshot.world.lore).toBe("The land of Ash");
    expect(snapshot.world.tone).toBe("noir");
    expect(snapshot.world.openingScenario).toBe("You wake in a cell");
    expect(snapshot.world.dimensions).toEqual({
      tone: "noir",
      startingConditions: { openingScenario: "You wake in a cell" },
    });
    expect(snapshot.world.schema).toEqual({
      dimensions: { tone: "noir" },
      startingConditions: { openingScenario: "X" },
    });

    expect(Array.isArray(snapshot.world.entries)).toBe(true);
    expect(snapshot.world.entries).toHaveLength(2);
    expect(snapshot.world.entries?.[0]).toEqual({
      key: "alpha",
      content: "Alpha content",
    });
    expect(snapshot.world.entries?.[1]).toEqual({
      key: "beta",
      content: "Beta content",
    });
  });

  it("leaves world entries empty when no lorebook entries exist", async () => {
    const store = createMemoryStore();
    await store.upsertWorld(
      makeWorld({ id: "w2", lore: undefined, metadata: undefined }),
    );
    await store.createSession(
      makeSession({ id: "sess-fallback", worldId: "w2" }),
    );
    const snapshot = await buildSessionContextSnapshot(store, "sess-fallback", {
      locale: "zh-CN",
      turnNumber: 0,
      worldId: "w2",
      worldDataPluginId: "world-data",
    });

    expect(snapshot.world.entries).toEqual([]);
  });
});

// ── Test C: Working memory + core memory + summaries ────────────

describe("buildSessionContextSnapshot — memory + summaries wiring", () => {
  it("threads workingMemory, coreMemoryBlocks and summaries through correctly", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertCharacter(makeCharacter());
    await store.upsertWorkingMemory(
      makeWorkingMemory({
        id: "wm-1",
        key: "foo",
        scope: "shared",
        value: "bar",
      }),
    );
    await store.savePlayerInput(
      makePlayerInput({ id: "pi-1", values: { choice: "left" } }),
    );

    const coreMemoryBlocks = [
      { label: "persona", content: "X", updatedAt: "2026-01-01" },
    ] as const;
    const summaries = [
      { id: "s1", content: "summary text", focusSections: ["scene"] },
    ] as const;

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 3,
      coreMemoryBlocks,
      summaries,
    });

    expect(snapshot.workingMemory).toEqual([
      { scope: "shared", key: "foo", value: "bar" },
    ]);
    expect(snapshot.coreMemoryBlocks).toEqual(coreMemoryBlocks);
    expect(snapshot.summaries).toEqual(summaries);

    // Character + player input wiring
    expect(snapshot.characters).toEqual([
      {
        name: "Hero",
        type: "player",
        description: undefined,
        fields: undefined,
      },
    ]);
    expect(snapshot.sessionMeta.lastFormValues).toEqual({ choice: "left" });
    expect(snapshot.sessionMeta.turnNumber).toBe(3);
  });
});

describe("buildSessionContextSnapshot — player identity wiring", () => {
  it("loads active player identity from plugin data and compiles a persona contribution", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.setPluginData(
      makePluginData({
        pluginId: "player-identity",
        namespace: "profiles",
        key: "wanderer",
        value: {
          profile: {
            schemaVersion: 1,
            id: "wanderer",
            name: "Wanderer",
            description: "A cautious outsider with a hidden map.",
            promptCoordinate: { position: "seg3_prepend", order: 2 },
          },
          updatedAt: ts(),
        },
      }),
    );
    await store.setPluginData(
      makePluginData({
        pluginId: "player-identity",
        namespace: "session-binding",
        key: "current",
        value: {
          profileId: "wanderer",
          characterId: "player-wanderer",
          updatedAt: ts(),
        },
      }),
    );

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 4,
      personaPluginId: "player-identity",
    });

    expect(snapshot.activePersona).toEqual({
      id: "wanderer",
      name: "Wanderer",
      description: "A cautious outsider with a hidden map.",
      promptCoordinate: { position: "seg3_prepend", order: 2 },
    });
    expect(snapshot.contributions).toEqual([
      {
        kind: "persona_description",
        sourceType: "persona",
        sourceId: "wanderer",
        content: [
          "[Player Persona]",
          "Name: Wanderer",
          "Description: A cautious outsider with a hidden map.",
        ].join("\n"),
        position: "seg3_prepend",
        order: 2,
      },
    ]);
  });

  it("loads no persona when no persona-provider plugin id is supplied", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.setPluginData(
      makePluginData({
        pluginId: "player-identity",
        namespace: "session-binding",
        key: "current",
        value: { profileId: "wanderer", updatedAt: ts() },
      }),
    );

    // Framework discovered no `persona-provider` capability → personaPluginId
    // omitted → persona stays off, never hardcoded to a specific plugin.
    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 4,
    });

    expect(snapshot.activePersona).toBeUndefined();
    expect(
      snapshot.contributions.some((c) => c.kind === "persona_description"),
    ).toBe(false);
  });
});

describe("buildSessionContextSnapshot — lorebook contributions", () => {
  it("compiles enabled constant lorebook entries into lore contributions", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertLorebookEntries([
      makeLorebookEntry({
        id: "rule-before",
        pluginId: "living-world-rules",
        content: "雨市里没人会直接说出真实姓名。",
        position: "before_plugin",
        insertionOrder: 20,
        extra: {
          title: "Rain Market",
          coordinate: { position: "before_plugin" },
          budgetClass: "sticky",
          sourceRuleId: "rain-market",
        },
      }),
    ]);

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 4,
    });

    expect(snapshot.contributions).toContainEqual({
      kind: "lore_entry",
      sourceType: "world",
      sourceId: "rule-before",
      content: "[World Rule: Rain Market]\n雨市里没人会直接说出真实姓名。",
      position: "before_plugin",
      order: 20,
      debugTrace: {
        pluginId: "living-world-rules",
        strategy: "constant",
        keys: [],
        sourceRuleId: "rain-market",
      },
    });
  });

  it("activates selective lorebook entries from the current player message", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertLorebookEntries([
      makeLorebookEntry({
        id: "sealed-door",
        pluginId: "living-world-rules",
        content: "封印门只回应血脉、月光和旧誓。",
        strategy: "selective",
        keys: ["封印门"],
        position: "at_depth",
        insertionOrder: 30,
        extra: {
          coordinate: { position: "at_depth", depth: 2 },
        },
      }),
      makeLorebookEntry({
        id: "silent-rule",
        pluginId: "living-world-rules",
        content: "Unmatched rule",
        strategy: "selective",
        keys: ["不会命中"],
        insertionOrder: 40,
      }),
    ]);

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 4,
      playerMessage: "我检查封印门上的月光痕迹。",
    });

    const loreContributions = snapshot.contributions.filter(
      (contribution) => contribution.kind === "lore_entry",
    );
    expect(
      loreContributions.map((contribution) => contribution.sourceId),
    ).toEqual(["sealed-door"]);
    expect(loreContributions[0]).toMatchObject({
      position: "at_depth",
      depth: 2,
      content: "[World Rule: 封印门]\n封印门只回应血脉、月光和旧誓。",
    });
  });
});

// ── Test D: Graceful degradation ────────────────────────────────

describe("buildSessionContextSnapshot — graceful degradation", () => {
  it("swallows store failures and returns a valid empty snapshot", async () => {
    const failingStore: Partial<DataStore> = {
      getSession: async () => {
        throw new Error("boom");
      },
      listCharacters: async () => {
        throw new Error("boom");
      },
      listPlayerInputs: async () => {
        throw new Error("boom");
      },
      listWorkingMemory: async () => {
        throw new Error("boom");
      },
      listSessionLorebookEntries: async () => {
        throw new Error("boom");
      },
      getWorld: async () => {
        throw new Error("boom");
      },
      listPluginData: async () => {
        throw new Error("boom");
      },
    };

    const snapshot = await buildSessionContextSnapshot(
      failingStore as DataStore,
      "sess-broken",
      {
        locale: "zh-CN",
        turnNumber: 0,
        worldId: "w-broken",
        worldDataPluginId: "world-data",
      },
    );

    expect(snapshot.characters).toEqual([]);
    expect(snapshot.workingMemory).toEqual([]);
    expect(snapshot.loreEntries).toEqual([]);
    expect(snapshot.world).toEqual({ id: "w-broken", entries: [] });
    expect(snapshot.sessionMeta.lastFormValues).toBeUndefined();
  });
});
