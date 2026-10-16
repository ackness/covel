import { supportsVector, type VectorSearchResult } from "@covel/store/vector";

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
 * one `Float32Array` per input string, in order. Implementations must enforce
 * context.modelId before issuing provider work; matching dimensions alone do
 * not put embeddings from different models in the same vector space.
 */
export type EmbedFn = (
  texts: readonly string[],
  context: { readonly sessionId: string; readonly modelId: string },
) => Promise<readonly Float32Array[]>;

/**
 * Thrown by an {@link EmbedFn} when the embedding model configured now is not
 * the one the session's index was built with. Nothing can be indexed or
 * searched by vector until the configuration is restored or the index is
 * rebuilt; memory search falls back to keywords meanwhile.
 */
export class EmbeddingModelChangedError extends Error {
  readonly code = "embedding_model_changed";
  constructor(message = "The embedding model changed for this session") {
    super(message);
    this.name = "EmbeddingModelChangedError";
  }
}

/** True for {@link EmbeddingModelChangedError}, also across module copies. */
export function isEmbeddingModelChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "embedding_model_changed"
  );
}

/**
 * Reserved, framework-internal "plugin id" used to partition memory's own
 * vectors inside the shared per-session vector table.
 *
 * This is a storage partition key, NOT plugin dispatch — the framework never
 * branches behavior on it (isolation rule). The leading/trailing underscores
 * make it impossible to collide with a real plugin id (npm package names, from
 * which plugin ids derive, cannot begin with `_`).
 */
export const MEMORY_VECTOR_PLUGIN_ID = "__kernel:vector";

/** Namespace for embedded conversation-history (recall) vectors. */
export const RECALL_NAMESPACE = "recall";

/** Namespace for embedded archival (lorebook, character and plugin data) vectors. */
export const ARCHIVAL_NAMESPACE = "archival";

/**
 * Map a backend distance (lower = more similar; L2 for sqlite-vec / memory,
 * configurable for pgvector) to a bounded relevance score in `(0, 1]` where
 * higher = more relevant — matching the field contract of the keyword
 * searchers. Strictly monotonic decreasing in `distance`, so it preserves the
 * KNN ordering. NOT a calibrated cosine similarity; it is a presentation score
 * within one tier; cross-tier search combines rank order instead of scores.
 */
export function distanceToScore(distance: number): number {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  return 1 / (1 + d);
}

/** Cap on items embedded per ingestion sweep — bounds a cold-start backfill burst. */
export const MAX_INGEST_BATCH = 128;

/** Null means the caller should use keyword search for this session. */
export async function searchSessionVectors(
  store: object,
  embed: EmbedFn,
  sessionId: string,
  query: string,
  limit: number,
  namespace: string,
): Promise<readonly VectorSearchResult[] | null> {
  if (!supportsVector(store)) return null;
  const target = await store.resolveSessionVectorTarget(sessionId);
  if (!target) return null;
  const [queryVector] = await embed([query], {
    sessionId,
    modelId: target.modelId,
  });
  if (!queryVector?.length) return null;
  const results = await store.searchVectors({
    sessionId,
    query: queryVector,
    topK: limit,
    pluginId: MEMORY_VECTOR_PLUGIN_ID,
    namespace,
  });
  return results.length ? results : null;
}

export function payloadContent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null &&
      typeof value === "object" &&
      "content" in value &&
      typeof value.content === "string"
      ? value.content
      : null;
  } catch {
    return null;
  }
}
