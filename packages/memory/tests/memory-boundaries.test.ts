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
  it("does not return deleted or changed knowledge before the next ingestion", async () => {
    const { store, memory, character } = await fixture();
    await memory.ingest("session");
    expect(await memory.archival.search("session", "Alice")).toHaveLength(1);
    await store.upsertCharacter({ ...character, description: "new harbour" });
    const current = await memory.archival.search("session", "Alice");
    expect(current).toHaveLength(1);
    expect(current[0].content).toContain("new harbour");
    expect(current[0].content).not.toContain("old observatory");
    await store.deleteCharacter("session", "character");
    expect(await memory.archival.search("session", "Alice")).toEqual([]);
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
    expect(rows[0].payload).toContain("Bob");
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
