import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { describe, it, expect } from "vitest";

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

let pgVectorAvailable = false;
try {
  const { default: postgres } = await import("postgres");
  const client = postgres(DATABASE_URL, { connect_timeout: 3 });
  // Requires the pgvector extension to be installable — that's what makes the
  // vector path real, vs. a plain PG that would throw on `CREATE EXTENSION`.
  await client`CREATE EXTENSION IF NOT EXISTS vector`;
  await client.end();
  pgVectorAvailable = true;
} catch {
  console.warn(
    "PostgreSQL with pgvector not available, skipping PgStore vector tests",
  );
}

if (pgVectorAvailable) {
  const { createPgStore } = await import("../src/postgres/pg-store.js");
  const { createIsolatedPgUrl } = await import("./pg-test-db.js");
  // Own database so this file never races the other PG test files on schema DDL.
  const isolatedUrl = await createIsolatedPgUrl(
    DATABASE_URL,
    "covel_test_vector",
  );

  runVectorStoreContractTests("PgStore (pgvector)", async () => {
    const store = await createPgStore(isolatedUrl, { freshSchema: true });
    if (!supportsVector(store)) {
      throw new Error(
        "PgStore does not expose VectorStoreCapability — pgvector extension missing.",
      );
    }
    return store;
  });
} else {
  describe("PgStore (pgvector) — skipped", () => {
    it("skipped — PostgreSQL with pgvector not available", () => {
      expect(true).toBe(true);
    });
  });
}
