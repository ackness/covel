/**
 * Shared primitives for the semantic (vector) memory tier.
 *
 * The memory package owns a small, framework-internal slice of the store's
 * per-session vector space. It is partitioned off from any plugin's own RAG
 * vectors by a reserved `pluginId` + fixed namespaces, so memory's
 * embed-on-write ingestion and a plugin's `plugin-data` vectors never collide
 * on the `(sessionId, pluginId, namespace, key)` quadruple.
 */

/**
 * Inject-only embedding function. The memory package never imports a concrete
 * provider — `@covel/ai-provider` is composed in at the server bootstrap layer
 * and handed in as this seam (mirrors how the LLM adapter is injected). Returns
 * one `Float32Array` per input string, in order. The dimension must match the
 * session's locked embedding model (the store throws on mismatch).
 */
export type EmbedFn = (
  texts: readonly string[],
) => Promise<readonly Float32Array[]>;

/**
 * Reserved, framework-internal "plugin id" used to partition memory's own
 * vectors inside the shared per-session vector table.
 *
 * This is a storage partition key, NOT plugin dispatch — the framework never
 * branches behavior on it (isolation rule). The leading/trailing underscores
 * make it impossible to collide with a real plugin id (npm package names, from
 * which plugin ids derive, cannot begin with `_`).
 */
export const MEMORY_VECTOR_PLUGIN_ID = "__memory__";

/** Namespace for embedded conversation-history (recall) vectors. */
export const RECALL_NAMESPACE = "recall";

/** Namespace for embedded archival (lorebook + character) vectors. */
export const ARCHIVAL_NAMESPACE = "archival";

/**
 * Map a backend distance (lower = more similar; L2 for sqlite-vec / memory,
 * configurable for pgvector) to a bounded relevance score in `(0, 1]` where
 * higher = more relevant — matching the field contract of the keyword
 * searchers. Strictly monotonic decreasing in `distance`, so it preserves the
 * KNN ordering. NOT a calibrated cosine similarity; it is a presentation score
 * so vector and keyword results can be merged/sorted uniformly.
 */
export function distanceToScore(distance: number): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  return 1 / (1 + d);
}

/** Cap on items embedded per ingestion sweep — bounds a cold-start backfill burst. */
export const MAX_INGEST_BATCH = 128;

/**
 * Stable, cheap content fingerprint (FNV-1a 32-bit, hex). Used to detect when a
 * mutable archival record (lorebook entry / character) changed and must be
 * re-embedded. Not cryptographic — collisions only cost a missed re-embed,
 * never corruption.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
