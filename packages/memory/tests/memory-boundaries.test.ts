import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createMemorySystem } from "../src/memory-system.js";

async function fixture(
  embed = async (texts: readonly string[]) =>
    texts.map(() => new Float32Array([1, 0])),
) {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  await store.createSession({
    locale: "en-US",
    id: "session",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  const target = await store.ensureVectorModel({
    provider: "test",
    modelName: "test",
    modelId: "test/test",
    dim: 2,
  });
  await store.lockSessionEmbeddingModel("session", target);
  const character = {
    id: "character",
    sessionId: "session",
    name: "Alice",
    type: "npc",
    description: "old observatory",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await store.upsertCharacter(character);
  const memory = createMemorySystem({ store, embed });
  return { store, memory, character };
}

describe("memory ownership boundaries", () => {
  it("keeps the newer index when an older instance finishes embedding last", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const {
      store,
      memory: older,
      character,
    } = await fixture(async (texts) => {
      entered.resolve();
      await release.promise;
      return texts.map(() => new Float32Array([1, 0]));
    });
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([0, 1])),
    );
    const newer = createMemorySystem({ store, embed });
    const pending = older.ingest("session");
    try {
      await entered.promise;
      await store.upsertCharacter({ ...character, description: "new harbour" });
      expect((await newer.ingest("session")).archival).toBe(1);
      release.resolve();
      await pending;
      expect((await newer.ingest("session")).archival).toBe(0);
      expect(embed).toHaveBeenCalledTimes(1);
      const rows = await store.searchVectors({
        sessionId: "session",
        query: new Float32Array([0, 1]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toContain("new harbour");
      // No source contains this word: a keyword fallback cannot hide a stale index.
      const hits = await newer.archival.search("session", "seaport");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.content).toContain("new harbour");
    } finally {
      release.resolve();
      await pending;
      await store.close();
    }
  });

  it("does not return deleted or changed knowledge before the next ingestion", async () => {
    const { store, memory, character } = await fixture();
    await memory.ingest("session");
    expect(await memory.archival.search("session", "Alice")).toHaveLength(1);
    await store.upsertCharacter({ ...character, description: "new harbour" });
    const current = await memory.archival.search("session", "Alice");
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toContain("new harbour");
    expect(current[0]!.content).not.toContain("old observatory");
    await store.deleteCharacter("session", "character");
    expect(await memory.archival.search("session", "Alice")).toEqual([]);
  });

  it("publishes archival deletions only with the successfully embedded batch", async () => {
    let fail = false;
    const { store, memory, character } = await fixture(async (texts) => {
      if (fail) throw new Error("synthetic embedding failure");
      return texts.map(() => new Float32Array([1, 0]));
    });
    const survivor = { ...character, id: "survivor", name: "Bob" };
    await store.upsertCharacter(survivor);
    await memory.ingest("session");
    const scope = {
      sessionId: "session",
      pluginId: "__kernel:vector",
      namespace: "archival-ingest",
    };
    const before = await store.getVectorIndexProgress(scope);
    const search = () =>
      store.searchVectors({
        sessionId: "session",
        query: new Float32Array([1, 0]),
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await store.deleteCharacter("session", character.id);
      await store.upsertCharacter({ ...survivor, description: "new harbour" });
      fail = true;
      expect((await memory.ingest("session")).archival).toBe(0);
      expect(await search()).toHaveLength(2);
      expect(await store.getVectorIndexProgress(scope)).toBe(before);
      fail = false;
      expect((await memory.ingest("session")).archival).toBe(1);
      const rows = await search();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toContain("new harbour");
    } finally {
      warn.mockRestore();
      await store.close();
    }
  });

  it("removes a deleted vector without paying to embed unchanged survivors", async () => {
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0])),
    );
    const { store, memory, character } = await fixture(embed);
    await store.upsertCharacter({ ...character, id: "survivor", name: "Bob" });
    await memory.ingest("session");
    expect(embed).toHaveBeenCalledTimes(1);
    await store.deleteCharacter("session", "character");
    expect((await memory.ingest("session")).archival).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
    const rows = await store.searchVectors({
      sessionId: "session",
      query: new Float32Array([1, 0]),
      topK: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toContain("Bob");
    expect(await store.listPluginDataSessionScope("session")).toEqual([]);
  });

  it("drains one instance independently while another embedding stays pending", async () => {
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const enteredA = Promise.withResolvers<void>();
    const enteredB = Promise.withResolvers<void>();
    const a = await fixture(async (texts) => {
      enteredA.resolve();
      await releaseA.promise;
      return texts.map(() => new Float32Array([1, 0]));
    });
    const b = await fixture(async (texts) => {
      enteredB.resolve();
      await releaseB.promise;
      return texts.map(() => new Float32Array([1, 0]));
    });
    const runningA = a.memory.ingest("session");
    const runningB = b.memory.ingest("session");
    try {
      await Promise.all([enteredA.promise, enteredB.promise]);
      expect(a.memory.pendingTaskCount()).toBe(1);
      expect(b.memory.pendingTaskCount()).toBe(1);
      const drainingA = a.memory.drain();
      releaseA.resolve();
      expect((await drainingA).awaited).toBe(1);
      expect(a.memory.pendingTaskCount()).toBe(0);
      expect(b.memory.pendingTaskCount()).toBe(1);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([runningA, runningB]);
    }
  });
});

describe("unified memory search", () => {
  it("shares one embedding across tiers but not across queries", async () => {
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0])),
    );
    const { store, memory } = await fixture(embed);
    await memory.ingest("session");
    embed.mockClear();
    const searchVectors = vi.spyOn(store, "searchVectors");
    const hits = await memory.search("session", "Alice");
    expect(hits[0]?.source).toBe("archival:character");
    expect(embed).toHaveBeenCalledExactlyOnceWith(["Alice"], {
      sessionId: "session",
      modelId: "test/test",
    });
    expect(
      searchVectors.mock.calls.map(([request]) => request.namespace).sort(),
    ).toEqual(["archival", "recall"]);
    await memory.search("session", "Bob");
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1]?.[0]).toEqual(["Bob"]);
  });

  it("interleaves local rankings even when one tier falls back to keywords", async () => {
    const { store, memory, character } = await fixture();
    for (let n = 1; n <= 2; n++) {
      await store.appendTurnMessage({
        id: `m${n}`,
        sessionId: "session",
        turnId: `t${n}`,
        sourceType: "player",
        role: "user",
        content: `Alice visited ${n}`,
        order: n,
        createdAt: `2026-01-01T00:00:0${n}.000Z`,
      });
    }
    await memory.ingest("session");
    await store.upsertCharacter({
      ...character,
      description: "Alice has moved to the harbor",
    });
    const hits = await memory.search("session", "Alice", { limit: 3 });
    expect(hits.map((hit) => hit.source)).toEqual([
      "recall",
      "archival:character",
      "recall",
    ]);
    expect(hits[1]?.content).toContain("harbor");
    expect(
      await memory.search("session", "Alice", { scope: "recall", limit: 1 }),
    ).toHaveLength(1);
  });

  it("falls back in both tiers after a single failed embedding request", async () => {
    const failure = vi.fn(async () => {
      throw new Error("synthetic embedding outage");
    });
    const { memory } = await fixture(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await memory.search("session", "Alice"))[0]?.source).toBe(
        "archival:character",
      );
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("incremental archival ingestion (F-039)", () => {
  const facts = (count: number, prefix = "fact") =>
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      sessionId: "session",
      pluginId: "journal",
      namespace: "facts",
      key: `${prefix}-${i}`,
      value: { text: `${prefix} number ${i}`, note: `${prefix} note ${i}` },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

  async function searchable(
    declared: { pluginId: string; namespace: string; textField: string }[],
  ) {
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0])),
    );
    const { store, character } = await fixture();
    const sources = { current: declared };
    const memory = createMemorySystem({
      store,
      embed,
      searchablePluginData: async () => sources.current,
    });
    const corpusReads = [
      vi.spyOn(store, "listCharacters"),
      vi.spyOn(store, "listSessionLorebookEntries"),
      vi.spyOn(store, "listPluginData"),
      vi.spyOn(store, "listPluginDataSessionScope"),
    ];
    const archivalKeys = async () =>
      (
        await store.searchVectors({
          sessionId: "session",
          query: new Float32Array([1, 0]),
          topK: 500,
          pluginId: "__kernel:vector",
          namespace: "archival",
        })
      )
        .map((row) => row.key)
        .sort();
    return {
      store,
      memory,
      embed,
      character,
      sources,
      corpusReads,
      archivalKeys,
    };
  }
  const journal = {
    pluginId: "journal",
    namespace: "facts",
    textField: "text",
  };

  it("reads only the changed record after the index has caught up", async () => {
    const { store, memory, embed, corpusReads } = await searchable([journal]);
    await store.setPluginDataBatch(facts(200));
    // 1 character + 200 facts: two sweeps of at most 128 changes.
    expect((await memory.ingest("session")).archival).toBe(201);
    embed.mockClear();
    const get = vi.spyOn(store, "getPluginData");

    await store.setPluginData({
      ...facts(200)[7]!,
      value: { text: "fact number 7, revised" },
    });
    expect((await memory.ingest("session")).archival).toBe(1);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toEqual(["fact number 7, revised"]);
    expect(get).toHaveBeenCalledTimes(1);
    for (const read of corpusReads) expect(read).not.toHaveBeenCalled();

    // A rewrite that keeps the text costs a read, not an embedding.
    await store.setPluginData({
      ...facts(200)[7]!,
      value: { text: "fact number 7, revised", note: "touched" },
    });
    expect((await memory.ingest("session")).archival).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("checks only the records its hits name when searching", async () => {
    const { store, memory, corpusReads } = await searchable([journal]);
    await store.setPluginDataBatch(facts(50));
    await memory.ingest("session");
    const get = vi.spyOn(store, "getPluginData");
    const hits = await memory.archival.search("session", "seaport", 3);
    expect(hits).toHaveLength(3);
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
    for (const read of corpusReads) expect(read).not.toHaveBeenCalled();
  });

  it("keeps vectors when a changed text field contains the same text", async () => {
    const { store, memory, sources, archivalKeys } = await searchable([journal]);
    await store.setPluginDataBatch(
      facts(3).map((row) => ({
        ...row,
        value: { text: row.value.text, note: row.value.text },
      })),
    );
    await memory.ingest("session");
    const before = await archivalKeys();
    expect(before).toHaveLength(4);

    sources.current = [{ ...journal, textField: "note" }];
    await memory.ingest("session");
    expect(await archivalKeys()).toEqual(before);
    // Advancing the cursor must not leave the vectors missing on later sweeps.
    await memory.ingest("session");
    expect(await archivalKeys()).toEqual(before);
  });

  it("adds a namespace that becomes searchable and removes one that stops", async () => {
    const { store, memory, sources, archivalKeys } = await searchable([]);
    await store.setPluginDataBatch(facts(3));
    await memory.ingest("session");
    expect(await archivalKeys()).toEqual([
      JSON.stringify(["character", "character"]),
    ]);

    // The cursor has passed these records: the new namespace is walked again.
    sources.current = [journal];
    expect((await memory.ingest("session")).archival).toBe(3);
    expect(await archivalKeys()).toHaveLength(4);
    const hits = await memory.archival.search("session", "seaport", 10);
    expect(hits.filter((hit) => hit.source === "plugin_data")).toHaveLength(3);

    // A changed text field is the same keys under new text.
    sources.current = [{ ...journal, textField: "note" }];
    expect((await memory.ingest("session")).archival).toBe(3);
    const notes = await memory.archival.search("session", "seaport", 10);
    expect(
      notes.filter((hit) => hit.source === "plugin_data").map((h) => h.content),
    ).toEqual(expect.arrayContaining(["fact note 0", "fact note 2"]));

    sources.current = [];
    expect((await memory.ingest("session")).archival).toBe(0);
    expect(await archivalKeys()).toEqual([
      JSON.stringify(["character", "character"]),
    ]);
  });
});
