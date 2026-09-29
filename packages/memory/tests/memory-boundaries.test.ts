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
