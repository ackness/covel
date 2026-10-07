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

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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

    afterEach(async () => {
      await store.close();
    });

    it("cleans NUL from vector payloads and rejects NUL identities", async () => {
      await setupSessionWithModel(store, "nul-session", 2);
      const input = {
        sessionId: "nul-session",
        pluginId: "owner",
        namespace: "recall",
        key: "chunk",
        embedding: new Float32Array([0, 1]),
        payload: "left\u0000right",
      };
      await store.upsertVector(input);
      const rows = await store.searchVectors({
        sessionId: "nul-session",
        query: input.embedding,
        topK: 10,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toBe("leftright");
      await expect(
        store.upsertVector({ ...input, key: "bad\u0000key" }),
      ).rejects.toThrow("U+0000");
      expect(
        await store.searchVectors({
          sessionId: "nul-session",
          query: input.embedding,
          topK: 10,
        }),
      ).toHaveLength(1);
      expect(input.payload).toBe("left\u0000right");
    });

    it("reports Euclidean distance and fills topK after filtering other sessions", async () => {
      await setupSessionWithModel(store, "target", 2);
      await setupSessionWithModel(store, "other", 2);
      for (let index = 0; index < 70; index++) {
        await store.upsertVector({
          sessionId: "other",
          pluginId: "owner",
          namespace: "recall",
          key: String(index),
          embedding: new Float32Array([0, 0]),
        });
      }
      for (const [key, embedding] of [
        ["near", [3, 4]],
        ["far", [6, 8]],
      ] as const) {
        await store.upsertVector({
          sessionId: "target",
          pluginId: "owner",
          namespace: "recall",
          key,
          embedding: new Float32Array(embedding),
        });
      }
      const results = await store.searchVectors({
        sessionId: "target",
        query: new Float32Array([0, 0]),
        topK: 2,
      });
      expect(results.map(({ key }) => key)).toEqual(["near", "far"]);
      expect(results.map(({ distance }) => distance)).toEqual([5, 10]);
    });

    it("deletes one key without removing surviving vectors or other namespaces", async () => {
      await setupSessionWithModel(store, "s1", 2);
      const embedding = new Float32Array([1, 0]);
      for (const [namespace, key] of [
        ["archive", "removed"],
        ["archive", "kept"],
        ["other", "removed"],
      ]) {
        await store.upsertVector({
          sessionId: "s1",
          pluginId: "owner",
          namespace,
          key,
          embedding,
        });
      }
      await expect(
        store.deleteVectors({
          sessionId: "s1",
          pluginId: "owner",
          namespace: "archive",
          key: "removed",
          expectedSessionCreatedAt: "stale-incarnation",
        }),
      ).rejects.toThrow("incarnation changed");
      await store.deleteVectors({
        sessionId: "s1",
        pluginId: "owner",
        namespace: "archive",
        key: "removed",
      });
      const results = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
        topK: 10,
      });
      expect(
        results.map((row) => `${row.namespace}/${row.key}`).sort(),
      ).toEqual(["archive/kept", "other/removed"]);
    });

    it("isolates index progress, compares revisions atomically and rejects stale incarnations", async () => {
      await setupSessionWithModel(store, "s1", 2);
      const session = (await store.getSession("s1"))!;
      const scope = { sessionId: "s1", pluginId: "owner", namespace: "recall" };
      const input = {
        ...scope,
        value: "first",
        expectedValue: null,
        expectedSessionCreatedAt: session.createdAt,
      };
      expect(await store.getVectorIndexProgress(scope)).toBeNull();
      const attempts = await Promise.all([
        store.commitVectorIndexBatch(input),
        store.commitVectorIndexBatch({ ...input, value: "second" }),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const current = await store.getVectorIndexProgress(scope);
      expect(
        await store.getVectorIndexProgress({ ...scope, pluginId: "other" }),
      ).toBeNull();
      expect(
        await store.getVectorIndexProgress({ ...scope, namespace: "other" }),
      ).toBeNull();
      expect(await store.listPluginDataSessionScope("s1")).toEqual([]);
      expect(
        await store.commitVectorIndexBatch({
          ...input,
          expectedValue: "wrong",
        }),
      ).toBe(false);
      expect(
        await store.commitVectorIndexBatch({
          ...input,
          expectedValue: current,
          value: "advanced",
        }),
      ).toBe(true);
      await expect(
        store.withTransaction(async (tx) => {
          await tx.deleteSession("s1");
          throw new Error("rollback deletion");
        }),
      ).rejects.toThrow("rollback deletion");
      expect(await store.getVectorIndexProgress(scope)).toBe("advanced");
      await store.deleteSession("s1");
      expect(await store.getVectorIndexProgress(scope)).toBeNull();
      await store.createSession({
        ...session,
        createdAt: "2030-01-01T00:00:00.000Z",
      });
      await expect(store.commitVectorIndexBatch(input)).rejects.toThrow(
        "incarnation changed",
      );
      expect(await store.getVectorIndexProgress(scope)).toBeNull();
    });

    it("commits exactly one initial batch with vectors matching its progress", async () => {
      await setupSessionWithModel(store, "s1", 2);
      const session = (await store.getSession("s1"))!;
      const scope = {
        sessionId: "s1",
        pluginId: "owner",
        namespace: "progress",
      };
      const embedding = new Float32Array([1, 0]);
      const attempts = await Promise.all(
        ["first", "second"].map((value) =>
          store.commitVectorIndexBatch({
            ...scope,
            value,
            expectedValue: null,
            expectedSessionCreatedAt: session.createdAt,
            upserts: [
              { namespace: "chunks", key: "shared", embedding, payload: value },
            ],
          }),
        ),
      );
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const winner = attempts[0] ? "first" : "second";
      expect(await store.getVectorIndexProgress(scope)).toBe(winner);
      const rows = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        namespace: "chunks",
        key: "shared",
        payload: winner,
      });
    });

    it("leaves committed vectors untouched when an older batch loses CAS", async () => {
      await setupSessionWithModel(store, "s1", 2);
      const session = (await store.getSession("s1"))!;
      const scope = {
        sessionId: "s1",
        pluginId: "owner",
        namespace: "progress",
      };
      const embedding = new Float32Array([1, 0]);
      const guard = { ...scope, expectedSessionCreatedAt: session.createdAt };
      expect(
        await store.commitVectorIndexBatch({
          ...guard,
          expectedValue: null,
          value: "new",
          upserts: [
            { namespace: "chunks", key: "shared", embedding, payload: "new" },
            { namespace: "chunks", key: "kept", embedding, payload: "kept" },
          ],
        }),
      ).toBe(true);
      expect(
        await store.commitVectorIndexBatch({
          ...guard,
          expectedValue: null,
          value: "old",
          deletes: [{ namespace: "chunks", key: "kept" }],
          upserts: [
            {
              namespace: "chunks",
              key: "shared",
              embedding: new Float32Array([0, 1]),
              payload: "old",
            },
          ],
        }),
      ).toBe(false);
      expect(await store.getVectorIndexProgress(scope)).toBe("new");
      const rows = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
      });
      expect(rows.map((row) => row.payload).sort()).toEqual(["kept", "new"]);
      expect(rows.every((row) => row.distance === 0)).toBe(true);
    });

    it("rolls back progress, deletes and earlier upserts when a later mutation fails", async () => {
      await setupSessionWithModel(store, "s1", 2);
      const session = (await store.getSession("s1"))!;
      const scope = {
        sessionId: "s1",
        pluginId: "owner",
        namespace: "progress",
      };
      const embedding = new Float32Array([1, 0]);
      const guard = { ...scope, expectedSessionCreatedAt: session.createdAt };
      await store.commitVectorIndexBatch({
        ...guard,
        expectedValue: null,
        value: "before",
        upserts: [
          { namespace: "chunks", key: "shared", embedding, payload: "before" },
          { namespace: "chunks", key: "kept", embedding, payload: "kept" },
        ],
      });
      await expect(
        store.commitVectorIndexBatch({
          ...guard,
          expectedValue: "before",
          value: "after",
          deletes: [{ namespace: "chunks", key: "kept" }],
          upserts: [
            { namespace: "chunks", key: "shared", embedding, payload: "after" },
            { namespace: "chunks", key: "inserted", embedding },
            {
              namespace: "chunks",
              key: "invalid",
              embedding: new Float32Array([1]),
            },
          ],
        }),
      ).rejects.toThrow(/dim|length/);
      expect(await store.getVectorIndexProgress(scope)).toBe("before");
      const rows = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
      });
      expect(rows.map((row) => row.payload).sort()).toEqual(["before", "kept"]);
      expect(
        await store.commitVectorIndexBatch({
          ...guard,
          expectedValue: "before",
          value: "after",
          deletes: [{ namespace: "chunks", key: "kept" }],
          upserts: [
            { namespace: "chunks", key: "shared", embedding, payload: "after" },
          ],
        }),
      ).toBe(true);
      expect(await store.getVectorIndexProgress(scope)).toBe("after");
      const committed = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
      });
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ key: "shared", payload: "after" });
    });

    it("rejects stale batches without touching the recreated session's vectors or progress", async () => {
      const target = await setupSessionWithModel(store, "s1", 2);
      const session = (await store.getSession("s1"))!;
      await store.deleteSession("s1");
      const createdAt = "2030-01-01T00:00:00.000Z";
      await store.createSession({
        ...session,
        createdAt,
        embeddingModelId: undefined,
        embeddingLockedAt: undefined,
      });
      await store.lockSessionEmbeddingModel("s1", target);
      const scope = {
        sessionId: "s1",
        pluginId: "owner",
        namespace: "progress",
      };
      const embedding = new Float32Array([1, 0]);
      const upserts = [
        { namespace: "chunks", key: "shared", embedding, payload: "new" },
      ];
      await store.commitVectorIndexBatch({
        ...scope,
        expectedSessionCreatedAt: createdAt,
        expectedValue: null,
        value: "new",
        upserts,
      });
      await expect(
        store.commitVectorIndexBatch({
          ...scope,
          expectedSessionCreatedAt: session.createdAt,
          expectedValue: "new",
          value: "old",
          deletes: [{ namespace: "chunks", key: "shared" }],
          upserts: [{ ...upserts[0], key: "stale", payload: "old" }],
        }),
      ).rejects.toThrow("incarnation changed");
      expect(await store.getVectorIndexProgress(scope)).toBe("new");
      const rows = await store.searchVectors({
        sessionId: "s1",
        query: embedding,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: "shared", payload: "new" });
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

    it("returns no results when topK is zero or negative", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      const query = seededVector(dim, 1);
      await store.upsertVector({
        sessionId: "s1",
        pluginId: "p",
        namespace: "ns",
        key: "k1",
        embedding: query,
      });

      await expect(
        store.searchVectors({ sessionId: "s1", query, topK: 0 }),
      ).resolves.toEqual([]);
      await expect(
        store.searchVectors({ sessionId: "s1", query, topK: -1 }),
      ).resolves.toEqual([]);
    });

    it("rejects non-safe-integer topK values", async () => {
      const dim = 16;
      await setupSessionWithModel(store, "s1", dim);
      const query = seededVector(dim, 1);

      for (const topK of [1.5, Number.NaN, Infinity, 2 ** 53]) {
        await expect(
          store.searchVectors({ sessionId: "s1", query, topK }),
        ).rejects.toBeInstanceOf(RangeError);
      }
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

    it("rejects a vector produced for a deleted session incarnation", async () => {
      const dim = 16;
      const target = await setupSessionWithModel(store, "reused-id", dim);
      const originalSession = await store.getSession("reused-id");
      expect(originalSession).not.toBeNull();

      await store.deleteSession("reused-id");
      const recreatedAt = new Date(
        Date.parse(originalSession!.createdAt) + 1_000,
      ).toISOString();
      await store.createSession({
        id: "reused-id",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        locale: "en",
        activePlugins: [],
        createdAt: recreatedAt,
        updatedAt: recreatedAt,
      });
      await store.lockSessionEmbeddingModel("reused-id", target);

      await expect(
        store.upsertVector({
          sessionId: "reused-id",
          expectedSessionCreatedAt: originalSession!.createdAt,
          pluginId: "p",
          namespace: "ns",
          key: "stale",
          embedding: seededVector(dim, 1),
        }),
      ).rejects.toThrow(/incarnation/i);

      await expect(
        store.searchVectors({
          sessionId: "reused-id",
          query: seededVector(dim, 1),
          topK: 5,
        }),
      ).resolves.toEqual([]);
    });

    it("returns empty array for session without locked model", async () => {
      // Create session but do NOT lock an embedding model
      await store.createSession({
        id: "no-model",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
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

    it("does not reuse a vector binding or rows after a session id is recreated", async () => {
      const sessionId = "s-recreated";
      const dim = 16;
      const target = await setupSessionWithModel(store, sessionId, dim);
      const vector = seededVector(dim, 41);
      await store.upsertVector({
        sessionId,
        pluginId: "p",
        namespace: "ns",
        key: "old-incarnation",
        embedding: vector,
      });
      await expect(
        store.resolveSessionVectorTarget(sessionId),
      ).resolves.toEqual(target);

      await store.deleteSession(sessionId);
      const now = new Date().toISOString();
      await store.createSession({
        id: sessionId,
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        locale: "en",
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        store.resolveSessionVectorTarget(sessionId),
      ).resolves.toBeNull();
      await store.lockSessionEmbeddingModel(sessionId, target);
      await expect(
        store.searchVectors({ sessionId, query: vector, topK: 5 }),
      ).resolves.toEqual([]);
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
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
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
