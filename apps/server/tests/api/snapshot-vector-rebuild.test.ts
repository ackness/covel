import { expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createMemorySystem } from "@covel/memory";
import { MEMORY_VECTOR_PLUGIN_ID } from "@covel/store/vector";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

for (const withCharacter of [false, true]) {
  it(`rebuilds forked indexes over multiple sweeps (character=${withCharacter})`, async () => {
    const store = createMemoryStore();
    const now = "2026-01-01T00:00:00.000Z";
    await store.createSession({
      id: "parent",
      status: "active",
      phase: "playing",
      locale: "en",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: [],
      metadata: {
        sessionIncarnationNonce: "test-nonce",
        approvalScopeNonce: "test-scope",
      },
      createdAt: now,
      updatedAt: now,
    });
    const target = await store.ensureVectorModel!({
      provider: "test",
      modelName: "embed",
      modelId: "test/embed",
      dim: 2,
    });
    await store.lockSessionEmbeddingModel!("parent", target);
    for (let i = 0; i < 130; i++) {
      await store.appendTurnMessage({
        id: `zz-old-${i.toString().padStart(3, "0")}`,
        sessionId: "parent",
        turnId: `t-${i}`,
        sourceType: "player",
        role: "user",
        content: `historical-${i}`,
        order: i,
        createdAt: now,
      });
    }
    await store.upsertLorebookEntries([
      {
        id: "lore",
        sessionId: "parent",
        owner: { kind: "world" },
        keys: ["lore"],
        content: "archival lore",
        strategy: "selective",
        position: "before",
        insertionOrder: 0,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    if (withCharacter)
      await store.upsertCharacter({
        id: "character",
        sessionId: "parent",
        name: "Character",
        type: "npc",
        version: 1,
        fields: {},
        createdAt: now,
        updatedAt: now,
      });
    const texts: string[] = [];
    const memory = createMemorySystem({
      store,
      embed: async (input) => {
        texts.push(...input);
        return input.map(() => new Float32Array([1, 0]));
      },
    });
    await memory.ingest("parent");
    await memory.ingest("parent");
    const progress = (await store.listPluginDataSessionScope("parent")).filter(
      (row) => row.pluginId === MEMORY_VECTOR_PLUGIN_ID,
    );
    expect(progress).toHaveLength(2);
    const app = new Hono<{
      Variables: { store: DataStore; sessionLock: SessionLock };
    }>();
    const sessionLock = createInProcessSessionLock();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/sessions", snapshotRoutes);
    const response = await app.request("/api/sessions/parent/snapshots", {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const snapshot = (await store.getSnapshot(id))!;
    expect(
      snapshot.payload.pluginData.some(
        (row) => row.pluginId === MEMORY_VECTOR_PLUGIN_ID,
      ),
    ).toBe(false);
    // The receiving boundary must also reject progress supplied in a payload.
    await store.saveSnapshot({
      ...snapshot,
      payload: {
        ...snapshot.payload,
        pluginData: [...snapshot.payload.pluginData, ...progress],
      },
    });
    const fork = await app.request("/api/sessions/parent/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromSnapshotId: id }),
    });
    expect(fork.status).toBe(201);
    const { sessionId } = (await fork.json()) as { sessionId: string };
    await store.lockSessionEmbeddingModel!(sessionId, target);
    texts.length = 0;
    await memory.ingest(sessionId);
    await memory.ingest(sessionId);
    expect(texts).toHaveLength(131 + Number(withCharacter));
    expect(texts.filter((text) => text.startsWith("historical-"))).toHaveLength(
      130,
    );
    const vectors = await store.searchVectors!({
      sessionId,
      query: new Float32Array([1, 0]),
      topK: 200,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
    });
    expect(vectors).toHaveLength(131 + Number(withCharacter));
    await memory.ingest(sessionId);
    expect(texts).toHaveLength(131 + Number(withCharacter));
    await store.close();
  });
}
