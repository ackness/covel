import { describe, it, expect, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  DataStore,
  CharacterRecord,
  LorebookEntryRecord,
  PlayerInputRecord,
  PluginDataRecord,
  SessionRecord,
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
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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
    owner: { kind: "world" },
    keys: [],
    content: "lorebook content",
    strategy: "constant",
    position: "after_plugin",
    insertionOrder: 100,
    enabled: true,
    createdAt: ts(),
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
  it.each([
    ["en-US", "Edited default lore"],
    ["zh-CN", "Translated lore"],
  ])(
    "uses the requested world lore edition for %s",
    async (locale, expected) => {
      const store = createMemoryStore();
      await store.upsertWorld(
        makeWorld({
          locale: "en-US",
          lore: "Edited default lore",
          metadata: {
            localizedText: {
              lore: { "en-US": "Old file lore", "zh-CN": "Translated lore" },
            },
          },
        }),
      );
      await store.createSession(makeSession());
      const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
        locale,
        turnNumber: 1,
        worldId: "w1",
      });
      expect(snapshot.world.lore).toBe(expected);
    },
  );

  it.each(["Player-edited lore", ""])(
    "uses the session lore override on every context rebuild (%j)",
    async (loreOverride) => {
      const store = createMemoryStore();
      await store.upsertWorld(makeWorld({ lore: "Original lore" }));
      await store.createSession(makeSession({ metadata: { loreOverride } }));

      const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
        locale: "zh-CN",
        turnNumber: 1,
        worldId: "w1",
      });

      expect(snapshot.world.lore).toBe(loreOverride);
    },
  );

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
      worldContext: {
        dimensions: {
          tone: {
            name: "Tone",
            schema: { type: "string" },
            value: "noir",
            version: 2,
          },
        },
        schema: {
          dimensions: { tone: "noir" },
          startingConditions: { openingScenario: "X" },
        },
      },
    });

    expect(snapshot.world.id).toBe("w1");
    expect(snapshot.world.name).toBe(world.name);
    expect(snapshot.world.description).toBe(world.description);
    expect(snapshot.world.lore).toBe("The land of Ash");
    expect(snapshot.world).not.toHaveProperty("tone");
    expect(snapshot.world).not.toHaveProperty("openingScenario");
    expect(snapshot.world.dimensions).toEqual({
      tone: {
        name: "Tone",
        schema: { type: "string" },
        value: "noir",
        version: 2,
      },
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
    });

    expect(snapshot.world.entries).toEqual([]);
  });
});

// ── Test C: Working memory + core memory + summaries ────────────

describe("buildSessionContextSnapshot — memory + summaries wiring", () => {
  it("threads summaries and committed character state through correctly", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertCharacter(makeCharacter());
    await store.savePlayerInput(
      makePlayerInput({ id: "pi-1", values: { choice: "left" } }),
    );

    const summaries = [
      { id: "s1", content: "summary text", focusSections: ["scene"] },
    ] as const;

    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "zh-CN",
      turnNumber: 3,
      summaries,
    });

    expect(snapshot.summaries).toEqual(summaries);

    // Character + player input wiring
    expect(snapshot.characters).toEqual([
      {
        id: "char-1",
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

    // Private plugin records never implicitly enter the kernel context.
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
        owner: { kind: "plugin", pluginId: "living-world-rules" },
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
      content: "[世界规则：Rain Market]\n雨市里没人会直接说出真实姓名。",
      position: "before_plugin",
      order: 20,
      debugTrace: {
        owner: { kind: "plugin", pluginId: "living-world-rules" },
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
        owner: { kind: "plugin", pluginId: "living-world-rules" },
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
        owner: { kind: "plugin", pluginId: "living-world-rules" },
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
      content: "[世界规则：封印门]\n封印门只回应血脉、月光和旧誓。",
    });

    // The heading follows the instruction language, not the entry's text.
    for (const locale of ["en-US", "zh-Hant-TW"]) {
      const other = await buildSessionContextSnapshot(store, "sess-1", {
        locale,
        turnNumber: 4,
        playerMessage: "我检查封印门上的月光痕迹。",
      });
      expect(
        other.contributions.find((item) => item.kind === "lore_entry")?.content,
      ).toBe("[World Rule: 封印门]\n封印门只回应血脉、月光和旧誓。");
    }
  });

  it("bounds selective history scans and matches Latin words without substring false positives", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertLorebookEntries([
      makeLorebookEntry({ id: "art", strategy: "selective", keys: ["art"] }),
      makeLorebookEntry({
        id: "moon",
        strategy: "selective",
        keys: ["月光"],
        extra: { scanDepth: 1 },
      }),
      makeLorebookEntry({
        id: "gate",
        strategy: "selective",
        keys: ["gate"],
        extra: { scanDepth: 2 },
      }),
      makeLorebookEntry({
        id: "default",
        strategy: "selective",
        keys: ["月光"],
      }),
      makeLorebookEntry({
        id: "too-old",
        strategy: "selective",
        keys: ["castle"],
        extra: { scanDepth: 2 },
      }),
    ]);
    const opts = {
      locale: "en-US",
      turnNumber: 4,
      recentMessages: [
        { content: "castle" },
        { content: "The gate opens." },
        { content: "月光照亮了庭院。" },
      ],
    };
    const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
      ...opts,
      playerMessage: "Join the party.",
    });
    expect(
      snapshot.contributions
        .filter((entry) => entry.kind === "lore_entry")
        .map((entry) => entry.sourceId),
    ).toEqual(["gate", "moon"]);
    const matched = await buildSessionContextSnapshot(store, "sess-1", {
      ...opts,
      playerMessage: "Inspect ART, then leave.",
    });
    expect(
      matched.contributions.some((entry) => entry.sourceId === "art"),
    ).toBe(true);
  });

  it("rejects unrecognized positions with a warning and applies the documented default", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertLorebookEntries([
      makeLorebookEntry({
        id: "legacy-alias",
        content: "position uses the removed before-memory alias",
        position: "before-memory",
        insertionOrder: 10,
      }),
      makeLorebookEntry({
        id: "typo-position",
        content: "position uses at-depth instead of at_depth",
        position: "at-depth",
        insertionOrder: 20,
      }),
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
        locale: "zh-CN",
        turnNumber: 4,
      });
      const bySource = new Map(
        snapshot.contributions.map((contribution) => [
          contribution.sourceId,
          contribution,
        ]),
      );
      // No undocumented alias, no silent downgrade: the entry still renders at
      // the documented default position, but the mistake is diagnosed.
      expect(bySource.get("legacy-alias")?.position).toBe("after_plugin");
      expect(bySource.get("typo-position")?.position).toBe("after_plugin");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'unrecognized lorebook position "before-memory"',
        ),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('unrecognized lorebook position "at-depth"'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for recognized lorebook positions", async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertLorebookEntries([
      makeLorebookEntry({ id: "ok", position: "before_plugin" }),
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await buildSessionContextSnapshot(store, "sess-1", {
        locale: "zh-CN",
        turnNumber: 4,
      });
      expect(
        snapshot.contributions.find((c) => c.sourceId === "ok")?.position,
      ).toBe("before_plugin");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
      getLatestPlayerInput: async () => {
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
      },
    );

    expect(snapshot.characters).toEqual([]);
    expect(snapshot.loreEntries).toEqual([]);
    expect(snapshot.world).toMatchObject({
      id: "w-broken",
      entries: [],
      dimensions: {},
    });
    expect(snapshot.sessionMeta.lastFormValues).toBeUndefined();
  });
});
