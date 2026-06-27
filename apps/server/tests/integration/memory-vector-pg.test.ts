/**
 * Real-PostgreSQL integration test for the semantic (vector) memory tier.
 *
 * The `@covel/memory` vector path (embed-on-write ingestion + KNN recall) is
 * unit-tested against `MemoryStore`'s vector primitives, and the store-level
 * `vector-store` contract exercises `PgStore`'s pgvector primitives directly.
 * This test closes the gap between them: it runs the actual memory ingestion +
 * recall logic over a real `PgStore` backed by a real pgvector database, proving
 * the combination works end-to-end (embed → upsertVector → searchVectors → rank)
 * on the production T3 backend — not just on Memory/sqlite-vec.
 *
 * Skipped automatically when `DATABASE_URL` is unset, PG is unreachable, or the
 * pgvector extension is unavailable — matches the other PG integration suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { DataStore } from "@covel/store";
import { createPgStore } from "@covel/store";
import { createMemorySystem } from "@covel/memory";
import type { MemoryLLMAdapter } from "@covel/memory";

const BASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const ISOLATED_DB = "covel_test_memory_vector_pg";

/** DROP+CREATE an isolated database so this file never clobbers other PG suites. */
async function createIsolatedPgUrl(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, connect_timeout: 3 });
    try {
      await admin`SELECT 1`;
      // Require pgvector — the whole point of this suite is the real vector path.
      await admin`CREATE EXTENSION IF NOT EXISTS vector`;
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${ISOLATED_DB}" WITH (FORCE)`,
      );
      await admin.unsafe(`CREATE DATABASE "${ISOLATED_DB}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(BASE_URL);
    url.pathname = `/${ISOLATED_DB}`;
    return url.toString();
  } catch {
    return null;
  }
}

const isolatedUrl = await createIsolatedPgUrl();

// Deterministic char-bag embedding (no provider). Texts sharing characters land
// closer in L2 space, so KNN ordering is testable; dimension is fixed at 64.
const DIM = 64;
function embedText(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const ch of text.toLowerCase()) {
    if (/\s/.test(ch)) continue;
    v[ch.charCodeAt(0) % DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i += 1) v[i] /= norm;
  return v;
}
const embed = async (texts: readonly string[]): Promise<Float32Array[]> =>
  texts.map(embedText);
const llm: MemoryLLMAdapter = { complete: async () => ({ content: "{}" }) };

const maybe = isolatedUrl ? describe : describe.skip;

maybe("memory vector recall over real PgStore (pgvector)", () => {
  let store: DataStore;
  const sessionId = "sess-pgvec-int";

  beforeAll(async () => {
    store = await createPgStore(isolatedUrl as string, { freshSchema: true });
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      worldId: "w1",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });
    const target = await store.ensureVectorModel!({
      provider: "test",
      modelName: "fake-embed",
      dim: DIM,
      modelId: "test/fake-embed",
    });
    await store.lockSessionEmbeddingModel!(sessionId, target);
    let order = 0;
    for (const content of [
      "the dragon breathed fire over the castle",
      "a merchant sold ripe apples at the market",
      "rivers flowed quietly through the green valley",
    ]) {
      order += 1;
      await store.appendTurnMessage({
        id: `m-${order}`,
        sessionId,
        turnId: `t-${order}`,
        sourceType: "runtime",
        role: "assistant",
        content,
        order,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
      });
    }
  });

  afterAll(async () => {
    await store?.close?.();
  });

  it("ingests messages and ranks the semantically closest first", async () => {
    const system = createMemorySystem({ store, llm, embed });

    const result = await system.ingest(sessionId);
    expect(result.skipped).toBe(false);
    expect(result.recall).toBe(3);

    const hits = await system.recall.search(sessionId, "dragon fire", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("dragon");
    // distance → score is monotonic, so scores are non-increasing.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("is incremental: a second ingest with no new messages embeds nothing", async () => {
    const system = createMemorySystem({ store, llm, embed });
    const result = await system.ingest(sessionId);
    expect(result.recall).toBe(0);
  });
});
