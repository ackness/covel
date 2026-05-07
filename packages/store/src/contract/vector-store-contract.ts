/**
 * Vector store contract — reusable test suite.
 *
 * Each backend (MemoryStore, SqliteStore via sqlite-vec, PgStore via
 * pgvector) runs the same behavioural assertions by passing a factory
 * that returns a store implementing DataStore, VectorStoreCapability,
 * and VectorModelOps.
 *
 * Contract guarantees tested here:
 *   1. upsertVector round-trips through searchVectors
 *   2. topK respects k
 *   3. Metadata filters (pluginId, namespace) narrow results
 *   4. session_id partitioning prevents cross-session leakage
 *   5. upsertVector is idempotent — same quadruple replaces previous row
 *   6. deleteVectors removes matching rows, leaves others intact
 *   7. Embedding length mismatch throws
 *   8. session without a locked model returns empty results
 *
 * Note: The old "multiple dimensions coexist" test is removed because
 * Phase 1 locks each session to a single embedding model, so mixing
 * dimensions within a session is not a supported scenario.
 */

import { describe, it, expect, beforeEach } from "vitest";

import type { DataStore } from "../types.js";
import type { VectorStoreCapability, VectorModelOps } from "../vector-store.js";

type VectorStore = DataStore & VectorStoreCapability & VectorModelOps;

function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const f of v) norm += f * f;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  let x = Math.sin(seed + 1) * 10000;
  for (let i = 0; i < dim; i += 1) {
    x = Math.sin(x + i) * 10000;
    v[i] = x - Math.floor(x);
  }
  return l2Normalize(v);
}

/**
 * Helper: create a session record and lock it to a given embedding model.
 * Returns the VectorTarget the session was locked to.
 */
async function setupSessionWithModel(
  store: VectorStore,
  sessionId: string,
  dim: number,
  modelId = "test/embedding-model",
  provider = "test",
  modelName = "embedding-model",
) {
  // Create a minimal session record so the DB FK holds.
  await store.createSession({
    id: sessionId,
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "en",
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const target = await store.ensureVectorModel({
    provider,
    modelName,
    dim,
    modelId,
  });
  await store.lockSessionEmbeddingModel(sessionId, target);
  return target;
}

export function runVectorStoreContractTests(
  name: string,
  createStore: () => Promise<VectorStore> | VectorStore,
): void {
  describe(`VectorStoreCapability — ${name}`, () => {
    let store: VectorStore;

    beforeEach(async () => {
      store = await createStore();
    });

    it("round-trips a single vector through search", async () => {
      const dim = 64;
      await setupSessionWithModel(store, "s1", dim);
      const vec = seededVector(dim, 1);
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "npc-graph",
        namespace: "edges",
        key: "edge-1",
        embedding: vec,
        payload: "hello world",
      });

      const results = await store.searchVectors({
        sessionId: "s1",
        query: vec,
        topK: 5,
      });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("edge-1");
      expect(results[0].pluginId).toBe("npc-graph");
      expect(results[0].namespace).toBe("edges");
      expect(results[0].payload).toBe("hello world");
    });

    it("respects topK", async () => {
      const dim = 32;
      await setupSessionWithModel(store, "s1", dim);
      for (let i = 0; i < 10; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: "p",
          namespace: "ns",
          key: `k${i}`,
          embedding: seededVector(dim, i),
        });
      }
      const results = await store.searchVectors({
        sessionId: "s1",
        query: seededVector(dim, 0),
        topK: 3,
      });
      expect(results).toHaveLength(3);
      expect(results[0].key).toBe("k0"); // exact match lands first
    });

    it("narrows by pluginId and namespace filters", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      // Three pluginId/namespace combos, same vectors
      const combos = [
        { pluginId: "npc-graph", namespace: "edges" },
        { pluginId: "npc-graph", namespace: "nodes" },
        { pluginId: "codex", namespace: "entries" },
      ];
      for (let i = 0; i < combos.length; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: combos[i].pluginId,
          namespace: combos[i].namespace,
          key: `k${i}`,
          embedding: seededVector(dim, i),
        });
      }
      const query = seededVector(dim, 999);

      const narrowed = await store.searchVectors({
        sessionId: "s1",
        query,
        topK: 10,
        pluginId: "npc-graph",
        namespace: "edges",
      });
      expect(narrowed).toHaveLength(1);
      expect(narrowed[0].key).toBe("k0");

      const pluginOnly = await store.searchVectors({
        sessionId: "s1",
        query,
        topK: 10,
        pluginId: "npc-graph",
      });
      expect(pluginOnly).toHaveLength(2);
      expect(pluginOnly.every((r) => r.pluginId === "npc-graph")).toBe(true);
    });

    it("isolates by session_id", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "session-A", dim);
      await setupSessionWithModel(store, "session-B", dim);
      const vec = seededVector(dim, 7);
      await store.upsertVector({
        sessionId: "session-A",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        embedding: vec,
      });
      await store.upsertVector({
        sessionId: "session-B",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        embedding: seededVector(dim, 8),
      });

      const fromA = await store.searchVectors({
        sessionId: "session-A",
        query: vec,
        topK: 10,
      });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].sessionId).toBe("session-A");
    });

    it("treats upsertVector on existing quadruple as replace", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      const key = "edge-1";
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key,
        embedding: seededVector(dim, 1),
        payload: "first",
      });
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key,
        embedding: seededVector(dim, 2),
        payload: "second",
      });

      const results = await store.searchVectors({
        sessionId: "s1",
        query: seededVector(dim, 2),
        topK: 10,
      });
      expect(results).toHaveLength(1);
      expect(results[0].payload).toBe("second");
    });

    it("deletes by pluginId + namespace, keeps other rows", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      for (let i = 0; i < 4; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: i < 2 ? "npc-graph" : "codex",
          namespace: "ns",
          key: `k${i}`,
          embedding: seededVector(dim, i),
        });
      }
      await store.deleteVectors({
        sessionId: "s1",
        pluginId: "npc-graph",
      });

      const remaining = await store.searchVectors({
        sessionId: "s1",
        query: seededVector(dim, 0),
        topK: 10,
      });
      expect(remaining.every((r) => r.pluginId === "codex")).toBe(true);
      expect(remaining).toHaveLength(2);
    });

    it("throws on embedding length mismatch in upsert", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      await expect(
        store.upsertVector({
          sessionId: "s1",
          pluginId: "p",
          namespace: "ns",
          key: "k",
          embedding: seededVector(32, 1), // wrong dim
        }),
      ).rejects.toThrow(/dim/i);
    });

    it("returns empty array for session without locked model", async () => {
      // Create session but do NOT lock an embedding model
      await store.createSession({
        id: "no-model",
        status: "active",
        turnCount: 1,
        preGameCompleted: [],
        locale: "en",
        activePlugins: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const results = await store.searchVectors({
        sessionId: "no-model",
        query: seededVector(128, 1),
        topK: 5,
      });
      expect(results).toEqual([]);
    });

    it("ensureVectorModel is idempotent and returns same target", async () => {
      const identity = {
        provider: "openai",
        modelName: "text-embedding-3-small",
        dim: 1536,
        modelId: "openai/text-embedding-3-small",
      };
      const t1 = await store.ensureVectorModel(identity);
      const t2 = await store.ensureVectorModel(identity);
      expect(t1.modelRegistryId).toBe(t2.modelRegistryId);
      expect(t1.dim).toBe(1536);
      expect(t1.tableName).toMatch(/^vec_mem_m\d+$/);
    });

    it("lockSessionEmbeddingModel throws if session already locked", async () => {
      const dim = 16;
      const target = await setupSessionWithModel(store, "s-lock", dim);
      await expect(
        store.lockSessionEmbeddingModel("s-lock", target),
      ).rejects.toThrow();
    });

    // ── ADR-004/005 core scenarios ───────────────────────────────

    it("isolates two sessions on different embedding models", async () => {
      // Two sessions, two distinct models with different identities.
      // Same dim is intentionally allowed — they must still land in
      // different physical tables because identity (not dim) is the
      // routing key.
      const dim = 32;
      const targetA = await setupSessionWithModel(
        store,
        "session-modelA",
        dim,
        "openai/text-embedding-3-small",
        "openai",
        "text-embedding-3-small",
      );
      const targetB = await setupSessionWithModel(
        store,
        "session-modelB",
        dim,
        "voyage/voyage-2",
        "voyage",
        "voyage-2",
      );

      expect(targetA.modelRegistryId).not.toBe(targetB.modelRegistryId);
      expect(targetA.tableName).not.toBe(targetB.tableName);

      // Write distinct payloads so we can prove no cross-table bleed.
      await store.upsertVector({
        sessionId: "session-modelA",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        embedding: seededVector(dim, 100),
        payload: "from-A",
      });
      await store.upsertVector({
        sessionId: "session-modelB",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        embedding: seededVector(dim, 200),
        payload: "from-B",
      });

      const fromA = await store.searchVectors({
        sessionId: "session-modelA",
        query: seededVector(dim, 100),
        topK: 5,
      });
      const fromB = await store.searchVectors({
        sessionId: "session-modelB",
        query: seededVector(dim, 200),
        topK: 5,
      });

      expect(fromA).toHaveLength(1);
      expect(fromA[0].payload).toBe("from-A");
      expect(fromB).toHaveLength(1);
      expect(fromB[0].payload).toBe("from-B");
    });

    it("reuses the original physical table when switching back to a previous model", async () => {
      // Step 1: Session 1 uses Model X — writes a vector.
      const dim = 24;
      const identityX = {
        provider: "openai",
        modelName: "text-embedding-3-small",
        dim,
        modelId: "openai/text-embedding-3-small",
      };
      const targetX1 = await setupSessionWithModel(
        store,
        "s1",
        dim,
        identityX.modelId,
        identityX.provider,
        identityX.modelName,
      );
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key: "old-key",
        embedding: seededVector(dim, 7),
        payload: "preserved",
      });

      // Step 2: Session 2 uses Model Y — gets a different physical table.
      const targetY = await setupSessionWithModel(
        store,
        "s2",
        dim,
        "ollama/nomic-embed-text",
        "ollama",
        "nomic-embed-text",
      );
      expect(targetY.modelRegistryId).not.toBe(targetX1.modelRegistryId);

      // Step 3: Session 3 switches BACK to Model X.
      // ensureVectorModel must return the SAME registry id and table.
      const targetX2 = await store.ensureVectorModel(identityX);
      expect(targetX2.modelRegistryId).toBe(targetX1.modelRegistryId);
      expect(targetX2.tableName).toBe(targetX1.tableName);

      // Step 4: Bind a fresh session to Model X and verify the historical
      // vector from session s1 is still searchable in s1's namespace
      // (session_id partitioning is preserved across the switch).
      await store.createSession({
        id: "s3",
        status: "active",
        turnCount: 1,
        preGameCompleted: [],
        locale: "en",
        activePlugins: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.lockSessionEmbeddingModel("s3", targetX2);

      // s1's old vector is intact.
      const fromS1 = await store.searchVectors({
        sessionId: "s1",
        query: seededVector(dim, 7),
        topK: 5,
      });
      expect(fromS1).toHaveLength(1);
      expect(fromS1[0].key).toBe("old-key");
      expect(fromS1[0].payload).toBe("preserved");

      // s3 sees nothing (no writes yet) but shares the physical table.
      const fromS3Empty = await store.searchVectors({
        sessionId: "s3",
        query: seededVector(dim, 7),
        topK: 5,
      });
      expect(fromS3Empty).toHaveLength(0);

      // Confirm registry has exactly two distinct models registered.
      const models = await store.listVectorModels();
      const ids = new Set(models.map((m) => m.modelId));
      expect(ids.has(identityX.modelId)).toBe(true);
      expect(ids.has("ollama/nomic-embed-text")).toBe(true);
    });
  });
}
