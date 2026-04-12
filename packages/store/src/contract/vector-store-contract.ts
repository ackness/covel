/**
 * Vector store contract — reusable test suite.
 *
 * Each backend (MemoryStore, SqliteStore via sqlite-vec, PgStore via
 * pgvector) runs the same behavioural assertions by passing a factory
 * that returns a store implementing both DataStore and
 * VectorStoreCapability.
 *
 * Contract guarantees tested here:
 *   1. upsertVector round-trips through searchVectors
 *   2. topK respects k
 *   3. Metadata filters (pluginId, namespace) narrow results
 *   4. session_id partitioning prevents cross-session leakage
 *   5. Multiple dimensions coexist without interference
 *   6. upsertVector is idempotent — same quadruple replaces previous row
 *   7. deleteVectors removes matching rows, leaves others intact
 *   8. Dimension mismatch throws
 *
 * The contract does NOT test specific distance numbers — different
 * backends use different metrics (L2 vs cosine vs dot). It asserts
 * *ordering*: the true nearest neighbor lands at position 0.
 */

import { describe, it, expect, beforeEach } from "vitest";

import type { DataStore } from "../types.js";
import type { VectorStoreCapability } from "../vector-store.js";

type VectorStore = DataStore & VectorStoreCapability;

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
      const vec = seededVector(dim, 1);
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "core-npc-graph",
        namespace: "edges",
        key: "edge-1",
        dimensions: dim,
        embedding: vec,
        payload: "hello world",
      });

      const results = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query: vec,
        topK: 5,
      });
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe("edge-1");
      expect(results[0].pluginId).toBe("core-npc-graph");
      expect(results[0].namespace).toBe("edges");
      expect(results[0].payload).toBe("hello world");
    });

    it("respects topK", async () => {
      const dim = 32;
      for (let i = 0; i < 10; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: "p",
          namespace: "ns",
          key: `k${i}`,
          dimensions: dim,
          embedding: seededVector(dim, i),
        });
      }
      const results = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query: seededVector(dim, 0),
        topK: 3,
      });
      expect(results).toHaveLength(3);
      expect(results[0].key).toBe("k0"); // exact match lands first
    });

    it("narrows by pluginId and namespace filters", async () => {
      const dim = 16;
      // Three pluginId/namespace combos, same vectors
      const combos = [
        { pluginId: "core-npc-graph", namespace: "edges" },
        { pluginId: "core-npc-graph", namespace: "nodes" },
        { pluginId: "core-codex", namespace: "entries" },
      ];
      for (let i = 0; i < combos.length; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: combos[i].pluginId,
          namespace: combos[i].namespace,
          key: `k${i}`,
          dimensions: dim,
          embedding: seededVector(dim, i),
        });
      }
      const query = seededVector(dim, 999);

      const narrowed = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query,
        topK: 10,
        pluginId: "core-npc-graph",
        namespace: "edges",
      });
      expect(narrowed).toHaveLength(1);
      expect(narrowed[0].key).toBe("k0");

      const pluginOnly = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query,
        topK: 10,
        pluginId: "core-npc-graph",
      });
      expect(pluginOnly).toHaveLength(2);
      expect(pluginOnly.every((r) => r.pluginId === "core-npc-graph")).toBe(true);
    });

    it("isolates by session_id", async () => {
      const dim = 16;
      const vec = seededVector(dim, 7);
      await store.upsertVector({
        sessionId: "session-A",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        dimensions: dim,
        embedding: vec,
      });
      await store.upsertVector({
        sessionId: "session-B",
        pluginId: "p",
        namespace: "ns",
        key: "k",
        dimensions: dim,
        embedding: seededVector(dim, 8),
      });

      const fromA = await store.searchVectors({
        sessionId: "session-A",
        dimensions: dim,
        query: vec,
        topK: 10,
      });
      expect(fromA).toHaveLength(1);
      expect(fromA[0].sessionId).toBe("session-A");
    });

    it("supports multiple dimensions independently", async () => {
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key: "small",
        dimensions: 8,
        embedding: seededVector(8, 1),
      });
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key: "large",
        dimensions: 64,
        embedding: seededVector(64, 2),
      });

      const small = await store.searchVectors({
        sessionId: "s1",
        dimensions: 8,
        query: seededVector(8, 1),
        topK: 10,
      });
      expect(small).toHaveLength(1);
      expect(small[0].key).toBe("small");

      const large = await store.searchVectors({
        sessionId: "s1",
        dimensions: 64,
        query: seededVector(64, 2),
        topK: 10,
      });
      expect(large).toHaveLength(1);
      expect(large[0].key).toBe("large");
    });

    it("treats upsertVector on existing quadruple as replace", async () => {
      const dim = 16;
      const key = "edge-1";
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key,
        dimensions: dim,
        embedding: seededVector(dim, 1),
        payload: "first",
      });
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key,
        dimensions: dim,
        embedding: seededVector(dim, 2),
        payload: "second",
      });

      const results = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query: seededVector(dim, 2),
        topK: 10,
      });
      expect(results).toHaveLength(1);
      expect(results[0].payload).toBe("second");
    });

    it("deletes by pluginId + namespace, keeps other rows", async () => {
      const dim = 16;
      for (let i = 0; i < 4; i += 1) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: i < 2 ? "core-npc-graph" : "core-codex",
          namespace: "ns",
          key: `k${i}`,
          dimensions: dim,
          embedding: seededVector(dim, i),
        });
      }
      await store.deleteVectors({
        sessionId: "s1",
        pluginId: "core-npc-graph",
      });

      const remaining = await store.searchVectors({
        sessionId: "s1",
        dimensions: dim,
        query: seededVector(dim, 0),
        topK: 10,
      });
      expect(remaining.every((r) => r.pluginId === "core-codex")).toBe(true);
      expect(remaining).toHaveLength(2);
    });

    it("throws on dimension mismatch in upsert", async () => {
      await expect(
        store.upsertVector({
          sessionId: "s1",
          pluginId: "p",
          namespace: "ns",
          key: "k",
          dimensions: 16,
          embedding: seededVector(32, 1),
        }),
      ).rejects.toThrow(/dimension/i);
    });

    it("returns empty array for an unused dimension", async () => {
      const results = await store.searchVectors({
        sessionId: "s1",
        dimensions: 128,
        query: seededVector(128, 1),
        topK: 5,
      });
      expect(results).toEqual([]);
    });
  });
}
