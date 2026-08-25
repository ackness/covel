import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { afterAll, afterEach, beforeEach, describe, it, expect } from "vitest";

import { runVectorStoreContractTests } from "../src/contract/vector-store-contract.js";
import { createMemoryStore } from "../src/memory/memory-store.js";
import { createSqliteStore } from "../src/sqlite/sqlite-store.js";
import { supportsVector } from "../src/vector-store.js";

// ── MemoryStore: always supports VectorStoreCapability ────────

runVectorStoreContractTests("MemoryStore", () => {
  const store = createMemoryStore();
  return store;
});

// ── SqliteStore: supports when sqlite-vec loads ──────────────

runVectorStoreContractTests("SqliteStore (sqlite-vec)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-vec-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const store = createSqliteStore(dbPath);
  if (!supportsVector(store)) {
    throw new Error(
      "SqliteStore does not expose VectorStoreCapability — sqlite-vec failed to load. Install sqlite-vec or skip this suite.",
    );
  }
  return store;
});

// ── PgStore: supports when the database has the pgvector extension ──
// Connect-or-skip so the suite stays green without a database; when a real
// pgvector-enabled PG is reachable it exercises the production vector path
// (upsert/search/delete via the `vector` type + pgvector distance operators),
// which neither the Memory nor sqlite-vec backend covers.

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";

let pgVectorAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  // Requires the pgvector extension to be installable — that's what makes the
  // vector path real, vs. a plain PG that would throw on `CREATE EXTENSION`.
  await client`CREATE EXTENSION IF NOT EXISTS vector`;
  await client.end();
  pgVectorAvailable = true;
} catch (error) {
  if (REQUIRE_PG) {
    throw new Error("PostgreSQL with pgvector is required for vector tests", {
      cause: error,
    });
  }
  console.warn(
    "PostgreSQL with pgvector not available, skipping PgStore vector tests",
  );
}

if (pgVectorAvailable) {
  const { createPgStore } = await import("../src/postgres/pg-store.js");
  const { createIsolatedPgDatabase } = await import("./pg-test-db.js");
  // Own database so this file never races the other PG test files on schema DDL.
  const isolated = await createIsolatedPgDatabase(
    DATABASE_URL,
    "covel_test_vector",
  );
  afterAll(() => isolated.cleanup());

  runVectorStoreContractTests("PgStore (pgvector)", async () => {
    const store = await createPgStore(isolated.url, { freshSchema: true });
    if (!supportsVector(store)) {
      throw new Error(
        "PgStore does not expose VectorStoreCapability — pgvector extension missing.",
      );
    }
    return store;
  });

  describe("PgStore vector model locking across instances", () => {
    let storeA: Awaited<ReturnType<typeof createPgStore>>;
    let storeB: Awaited<ReturnType<typeof createPgStore>>;

    beforeEach(async () => {
      storeA = await createPgStore(isolated.url, { freshSchema: true });
      storeB = await createPgStore(isolated.url);
      const now = new Date().toISOString();
      await storeA.createSession({
        id: "shared-session",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    afterEach(async () => {
      await Promise.all([storeA.close(), storeB.close()]);
    });

    it("refreshes an unlocked result after another instance locks the session", async () => {
      await expect(
        storeA.resolveSessionVectorTarget("shared-session"),
      ).resolves.toBeNull();
      const target = await storeB.ensureVectorModel({
        provider: "audit",
        modelName: "one",
        dim: 3,
        modelId: "audit/one",
      });
      await storeB.lockSessionEmbeddingModel("shared-session", target);

      await expect(
        storeA.resolveSessionVectorTarget("shared-session"),
      ).resolves.toMatchObject({ modelRegistryId: target.modelRegistryId });
    });

    it("invalidates a positive target after another instance recreates the session id", async () => {
      const target = await storeA.ensureVectorModel({
        provider: "audit",
        modelName: "one",
        dim: 3,
        modelId: "audit/one",
      });
      await storeA.lockSessionEmbeddingModel("shared-session", target);
      await expect(
        storeA.resolveSessionVectorTarget("shared-session"),
      ).resolves.toMatchObject({ modelRegistryId: target.modelRegistryId });

      await storeB.deleteSession("shared-session");
      const now = new Date().toISOString();
      await storeB.createSession({
        id: "shared-session",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        storeA.resolveSessionVectorTarget("shared-session"),
      ).resolves.toBeNull();
    });

    it("allows exactly one concurrent first lock", async () => {
      const [targetA, targetB] = await Promise.all([
        storeA.ensureVectorModel({
          provider: "audit",
          modelName: "one",
          dim: 3,
          modelId: "audit/one",
        }),
        storeB.ensureVectorModel({
          provider: "audit",
          modelName: "two",
          dim: 4,
          modelId: "audit/two",
        }),
      ]);

      const outcomes = await Promise.allSettled([
        storeA.lockSessionEmbeddingModel("shared-session", targetA),
        storeB.lockSessionEmbeddingModel("shared-session", targetB),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);

      const [resolvedA, resolvedB] = await Promise.all([
        storeA.resolveSessionVectorTarget("shared-session"),
        storeB.resolveSessionVectorTarget("shared-session"),
      ]);
      expect(resolvedA?.modelRegistryId).toBe(resolvedB?.modelRegistryId);
    });

    it("does not insert a vector after session cascade has passed its table", async () => {
      const target = await storeA.ensureVectorModel({
        provider: "audit",
        modelName: "delete-race",
        dim: 3,
        modelId: "audit/delete-race",
      });
      await storeA.lockSessionEmbeddingModel("shared-session", target);

      const { default: postgres } = await import("postgres");
      const blocker = postgres(isolated.url, { max: 1 });
      let release!: () => void;
      let markLocked!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const blockingTx = blocker.begin(async (tx) => {
        await tx`SELECT id FROM sessions WHERE id = 'shared-session' FOR UPDATE`;
        markLocked();
        await hold;
      });

      try {
        await locked;
        // The fixed cascade blocks on its parent lock before deleting vectors.
        // The legacy cascade passed the vector table and blocked only at the
        // final session DELETE, allowing the following upsert to become orphaned.
        const deleting = storeB.deleteSession("shared-session");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const upserting = storeA.upsertVector({
          sessionId: "shared-session",
          pluginId: "race",
          namespace: "race",
          key: "late",
          embedding: new Float32Array([1, 0, 0]),
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        release();
        await blockingTx;
        await deleting;
        await Promise.allSettled([upserting]);

        const now = new Date().toISOString();
        await storeB.createSession({
          id: "shared-session",
          status: "active",
          phase: "setup",
          completedPlayerTurns: 0,
          setupRuntimes: {},
          activePlugins: [],
          createdAt: now,
          updatedAt: now,
        });
        await storeB.lockSessionEmbeddingModel("shared-session", target);
        await expect(
          storeB.searchVectors({
            sessionId: "shared-session",
            query: new Float32Array([1, 0, 0]),
            topK: 5,
          }),
        ).resolves.toEqual([]);
      } finally {
        release();
        await blockingTx.catch(() => undefined);
        await blocker.end();
      }
    });
  });
} else {
  describe("PgStore (pgvector) — skipped", () => {
    it("skipped — PostgreSQL with pgvector not available", () => {
      expect(true).toBe(true);
    });
  });
}
