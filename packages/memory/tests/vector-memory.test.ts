import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";

import { createMemorySystem } from "../src/memory-system.js";
import { createVectorIngestor } from "../src/vector-ingest.js";
import {
  ARCHIVAL_NAMESPACE,
  MEMORY_VECTOR_PLUGIN_ID,
  RECALL_NAMESPACE,
  type EmbedFn,
} from "../src/vector-common.js";
import type { MemoryLLMAdapter } from "../src/types.js";

// ── Deterministic test embedding ─────────────────────────────────
// Char-bag-of-words into a fixed dim, L2-normalized. Texts that share
// characters/words land closer in L2 space, so KNN ordering is testable
// without a real provider. Works for ASCII and CJK alike.
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

const embed: EmbedFn = async (texts) => texts.map(embedText);

// Track embed calls so we can assert the hot-path contract / batching.
function spyEmbed(): { fn: EmbedFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: EmbedFn = async (texts) => {
    calls.push([...texts]);
    return texts.map(embedText);
  };
  return { fn, calls };
}

const llm: MemoryLLMAdapter = {
  complete: vi.fn(async () => ({ content: "{}" })),
};

// ── Store seeding helpers ────────────────────────────────────────

async function lockModel(store: DataStore, sessionId: string): Promise<void> {
  // supportsVector(store) is true for MemoryStore.
  const s = store as DataStore & {
    ensureVectorModel: NonNullable<DataStore["ensureVectorModel"]>;
    lockSessionEmbeddingModel: NonNullable<
      DataStore["lockSessionEmbeddingModel"]
    >;
  };
  const target = await s.ensureVectorModel({
    provider: "test",
    modelName: "fake-embed",
    dim: DIM,
    modelId: "test/fake-embed",
  });
  await s.lockSessionEmbeddingModel(sessionId, target);
}

let order = 0;
async function addMessage(
  store: DataStore,
  sessionId: string,
  role: string,
  content: string,
): Promise<void> {
  order += 1;
  await store.appendTurnMessage({
    id: `m-${order}`,
    sessionId,
    turnId: `t-${order}`,
    sourceType: role === "user" ? "player" : "runtime",
    role,
    content,
    order,
    // Distinct, increasing timestamps so the ingest cursor advances stably.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
  });
}

async function addCharacter(
  store: DataStore,
  sessionId: string,
  id: string,
  name: string,
  description: string,
): Promise<void> {
  await store.upsertCharacter({
    id,
    sessionId,
    name,
    type: "npc",
    description,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function addLorebook(
  store: DataStore,
  sessionId: string,
  id: string,
  keyword: string,
  content: string,
): Promise<void> {
  await store.upsertLorebookEntries([
    {
      id,
      sessionId,
      pluginId: "lore-plugin",
      keys: [keyword],
      content,
      strategy: "selective",
      position: "before",
      insertionOrder: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
}

describe("vector recall (semantic)", () => {
  let store: DataStore;
  const sessionId = "sess-vec-1";

  beforeEach(async () => {
    order = 0;
    store = createMemoryStore();
    await lockModel(store, sessionId);
    await addMessage(store, sessionId, "assistant", "the dragon breathed fire");
    await addMessage(store, sessionId, "assistant", "a merchant sold apples");
    await addMessage(
      store,
      sessionId,
      "assistant",
      "rivers flowed through the valley",
    );
  });

  it("ingest writes one recall vector per message into the vec table", async () => {
    const ingestor = createVectorIngestor({ store, embed });
    const result = await ingestor.ingest(sessionId);

    expect(result.skipped).toBe(false);
    expect(result.recall).toBe(3);

    // Verify they actually landed in the memory-owned recall partition.
    const s = store as DataStore & {
      searchVectors: NonNullable<DataStore["searchVectors"]>;
    };
    const hits = await s.searchVectors({
      sessionId,
      query: embedText("dragon"),
      topK: 10,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: RECALL_NAMESPACE,
    });
    expect(hits.length).toBe(3);
  });

  it("ranks the semantically closest message first", async () => {
    const system = createMemorySystem({ store, llm, embed });
    await system.ingest(sessionId);

    const results = await system.recall.search(sessionId, "dragon fire", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("dragon");
    // Scores are positive and descending (distance -> score is monotonic).
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("is incremental: a second sweep only embeds new messages", async () => {
    const { fn, calls } = spyEmbed();
    const ingestor = createVectorIngestor({ store, embed: fn });

    const first = await ingestor.ingest(sessionId);
    expect(first.recall).toBe(3);
    const firstBatchLen = calls[0].length;
    expect(firstBatchLen).toBe(3);

    // No new messages → nothing to embed on the second sweep.
    const second = await ingestor.ingest(sessionId);
    expect(second.recall).toBe(0);

    // Add one and confirm only it gets embedded.
    await addMessage(store, sessionId, "assistant", "the dragon returned home");
    const third = await ingestor.ingest(sessionId);
    expect(third.recall).toBe(1);
    const lastBatch = calls[calls.length - 1];
    expect(lastBatch).toEqual(["the dragon returned home"]);
  });
});

describe("vector archival (semantic over lorebook + characters)", () => {
  let store: DataStore;
  const sessionId = "sess-vec-arch";

  beforeEach(async () => {
    store = createMemoryStore();
    await lockModel(store, sessionId);
    await addCharacter(
      store,
      sessionId,
      "c1",
      "Aldric",
      "a grizzled blacksmith who forges swords",
    );
    await addCharacter(
      store,
      sessionId,
      "c2",
      "Mira",
      "a cheerful baker who bakes bread",
    );
    await addLorebook(
      store,
      sessionId,
      "l1",
      "forge",
      "the ancient forge glows with dragonfire",
    );
  });

  it("finds the most relevant archival record by semantics", async () => {
    const system = createMemorySystem({ store, llm, embed });
    const ingest = await system.ingest(sessionId);
    expect(ingest.archival).toBe(3);

    const results = await system.archival.search(
      sessionId,
      "blacksmith forge",
      3,
    );
    expect(results.length).toBeGreaterThan(0);
    // Top hit should be the blacksmith character or the forge lorebook entry.
    expect(["Aldric", "forge"]).toContain(results[0].key);
    expect(["character", "lorebook"]).toContain(results[0].source);
  });

  it("re-embeds an archival record only when its content changes", async () => {
    const { fn, calls } = spyEmbed();
    const ingestor = createVectorIngestor({ store, embed: fn });

    const first = await ingestor.ingest(sessionId);
    expect(first.archival).toBe(3);

    // Unchanged → no re-embed.
    const second = await ingestor.ingest(sessionId);
    expect(second.archival).toBe(0);

    // Mutate one character → exactly one re-embed.
    await addCharacter(
      store,
      sessionId,
      "c1",
      "Aldric",
      "a retired blacksmith who now paints",
    );
    const third = await ingestor.ingest(sessionId);
    expect(third.archival).toBe(1);
    expect(calls[calls.length - 1].length).toBe(1);
  });
});

describe("graceful degradation", () => {
  it("falls back to keyword when the session has no embedding model locked", async () => {
    const store = createMemoryStore();
    const sessionId = "sess-no-model";
    // No lockModel() — resolveSessionVectorTarget returns null.
    order = 0;
    await addMessage(store, sessionId, "assistant", "the dragon breathed fire");
    await addMessage(store, sessionId, "assistant", "a merchant sold apples");

    const { fn, calls } = spyEmbed();
    const system = createMemorySystem({ store, llm, embed: fn });

    // Ingest skips cleanly.
    const ingest = await system.ingest(sessionId);
    expect(ingest.skipped).toBe(true);

    // Search still returns keyword results without ever calling embed.
    const results = await system.recall.search(sessionId, "dragon", 5);
    expect(results.some((r) => r.content.includes("dragon"))).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("falls back to keyword when embedding throws (never breaks the turn)", async () => {
    const store = createMemoryStore();
    const sessionId = "sess-embed-fail";
    await lockModel(store, sessionId);
    order = 0;
    await addMessage(store, sessionId, "assistant", "the dragon breathed fire");
    // Seed a recall vector via a working embed so the index is non-empty.
    await createVectorIngestor({ store, embed }).ingest(sessionId);

    const boom: EmbedFn = async () => {
      throw new Error("embedding provider down");
    };
    const system = createMemorySystem({ store, llm, embed: boom });

    // Query embed throws → must degrade to keyword, not reject.
    const results = await system.recall.search(sessionId, "dragon", 5);
    expect(results.some((r) => r.content.includes("dragon"))).toBe(true);
  });

  it("stays keyword-only (ingest no-op) when no embed function is injected", async () => {
    const store = createMemoryStore();
    const sessionId = "sess-keyword-only";
    await lockModel(store, sessionId);
    order = 0;
    await addMessage(store, sessionId, "assistant", "the dragon breathed fire");

    const system = createMemorySystem({ store, llm }); // no embed
    const ingest = await system.ingest(sessionId);
    expect(ingest.skipped).toBe(true);
    expect(ingest.recall).toBe(0);

    const results = await system.recall.search(sessionId, "dragon", 5);
    expect(results.some((r) => r.content.includes("dragon"))).toBe(true);
  });
});

describe("vector recall", () => {
  let store: DataStore;
  const sessionId = "sess-vec-fixes";

  beforeEach(async () => {
    order = 0;
    store = createMemoryStore();
    await lockModel(store, sessionId);
  });

  it("does not advance the recall cursor past a message that got an empty embedding", async () => {
    await addMessage(store, sessionId, "assistant", "first message");
    await addMessage(store, sessionId, "assistant", "second message");
    await addMessage(store, sessionId, "assistant", "third message");

    // Embed returns empty for the 2nd item → ingestion must stop at the 1st and
    // leave the cursor before the gap so 2nd/3rd are retried, never dropped.
    let failOnce = true;
    const flaky: EmbedFn = async (texts) =>
      texts.map((t, i) => {
        if (failOnce && i === 1) return new Float32Array(0);
        return embedText(t);
      });

    const ingestor = createVectorIngestor({ store, embed: flaky });
    const first = await ingestor.ingest(sessionId);
    expect(first.recall).toBe(1); // only the 1st landed

    // Provider recovers → the skipped 2nd and the 3rd are both still ingested.
    failOnce = false;
    const second = await ingestor.ingest(sessionId);
    expect(second.recall).toBe(2);

    const hits = await (
      store as DataStore & {
        searchVectors: NonNullable<DataStore["searchVectors"]>;
      }
    ).searchVectors({
      sessionId,
      query: embedText("message"),
      topK: 10,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: RECALL_NAMESPACE,
    });
    expect(hits.length).toBe(3); // nothing silently dropped
  });

  it("tops up short vector results with keyword hits during backfill", async () => {
    // 3 messages live, but only the oldest is in the vector index (backfill lag).
    await addMessage(store, sessionId, "assistant", "the dragon breathed fire");
    await addMessage(store, sessionId, "assistant", "the dragon flew higher");
    await addMessage(store, sessionId, "assistant", "the dragon roared loud");

    // Seed only the first message into the vector table by hand.
    const s = store as DataStore & {
      upsertVector: NonNullable<DataStore["upsertVector"]>;
    };
    await s.upsertVector({
      sessionId,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: RECALL_NAMESPACE,
      key: "m-1",
      embedding: embedText("the dragon breathed fire"),
      payload: JSON.stringify({
        turnId: "t-1",
        role: "assistant",
        content: "the dragon breathed fire",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
      }),
    });

    const system = createMemorySystem({ store, llm, embed });
    const results = await system.recall.search(sessionId, "dragon", 3);
    // Vector had 1 hit; keyword tops it up to cover the un-indexed recent ones.
    expect(results.length).toBeGreaterThan(1);
    const contents = results.map((r) => r.content);
    expect(new Set(contents).size).toBe(contents.length); // deduped
  });

  it("purges archival vectors for a deleted record and bounds the hash map", async () => {
    await addCharacter(store, sessionId, "c1", "Aldric", "a blacksmith");
    await addLorebook(store, sessionId, "l1", "forge", "the ancient forge");
    const ingestor = createVectorIngestor({ store, embed });
    expect((await ingestor.ingest(sessionId)).archival).toBe(2);

    // Delete the character → next sweep must purge its stale vector.
    await store.deleteCharacter(sessionId, "c1");
    await ingestor.ingest(sessionId);

    const hits = await (
      store as DataStore & {
        searchVectors: NonNullable<DataStore["searchVectors"]>;
      }
    ).searchVectors({
      sessionId,
      query: embedText("blacksmith"),
      topK: 10,
      pluginId: MEMORY_VECTOR_PLUGIN_ID,
      namespace: ARCHIVAL_NAMESPACE,
    });
    // Only the surviving lorebook entry remains; the deleted character's vector
    // is gone (not returned as a stale hit).
    expect(hits.length).toBe(1);
    expect(hits.every((h) => !h.payload?.includes("Aldric"))).toBe(true);
  });
});
