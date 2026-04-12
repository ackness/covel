/**
 * Optional vector-search capability for stores that support it.
 *
 * This is intentionally NOT part of the core DataStore contract — not every
 * backend can implement ANN/brute-force vector search (IdbStore can't, for
 * example). Stores declare support by implementing this interface on top of
 * DataStore; consumers check via `supportsVector()` before using it.
 *
 * Design notes
 * ------------
 *
 * Per embedding model, vectors have a fixed dimension. Different embedding
 * models produce vectors in different semantic spaces, so cross-dimension
 * KNN is meaningless. Backends keep separate storage per dimension
 * (e.g. sqlite-vec: one vec0 virtual table per `dim`).
 *
 * Metadata filtering uses the same quadruple as `plugin_data`:
 *   `(sessionId, pluginId, namespace, key)`
 * plus an optional free-text `payload` column so callers can round-trip
 * the original chunk without a separate join to `plugin_data`.
 *
 * Vectors are passed as `Float32Array` — frontends should convert from
 * `number[]` once, not per call. Backends may internally serialize them
 * as JSON (sqlite-vec), raw bytes (pgvector), or keep them as typed arrays.
 */

import type { DataStore } from "./types.js";

/**
 * Request to upsert a single vector. The quadruple
 * `(sessionId, pluginId, namespace, key)` uniquely identifies a row —
 * re-upserting with the same quadruple replaces the embedding and payload.
 */
export interface UpsertVectorInput {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  /** Vector dimensionality. Must match `embedding.length`. */
  readonly dimensions: number;
  /** L2-normalized or raw embedding, per the caller's embedding model. */
  readonly embedding: Float32Array;
  /**
   * Optional round-trip payload — the original text chunk, a JSON blob,
   * etc. Returned verbatim by `searchVectors`. Backends store it alongside
   * the vector so KNN results do not require a JOIN to plugin_data.
   */
  readonly payload?: string;
}

/** Request to run a KNN search against a single-dimension vector space. */
export interface SearchVectorsInput {
  readonly sessionId: string;
  /**
   * Dimension of the query vector. Only rows with matching `dimensions`
   * are eligible — backends will throw if no storage exists for this dim.
   */
  readonly dimensions: number;
  readonly query: Float32Array;
  /** Top-k cap. Typical range: 3–30. */
  readonly topK: number;
  /** Optional narrowing — only match rows with this pluginId. */
  readonly pluginId?: string;
  /** Optional narrowing — only match rows with this namespace. */
  readonly namespace?: string;
}

/**
 * One KNN result row. `distance` is backend-specific (L2 for sqlite-vec,
 * cosine/L2/dot for pgvector — callers should treat "lower is more
 * similar" uniformly).
 */
export interface VectorSearchResult {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly distance: number;
  readonly payload: string | null;
}

/** Scope for bulk deletion. Omit fields to widen the scope. */
export interface DeleteVectorsInput {
  readonly sessionId: string;
  /** Required — prevents cross-plugin accidental deletion. */
  readonly pluginId: string;
  /** Optional — when omitted, wipes every namespace for the plugin. */
  readonly namespace?: string;
  /** Optional — restrict deletion to a specific dimension. */
  readonly dimensions?: number;
}

/**
 * Optional capability interface for stores that support vector search.
 *
 * Implementations MUST be lazy about per-dimension storage creation —
 * sqlite-vec needs a CREATE VIRTUAL TABLE the first time a new dim is
 * written. Pgvector uses a single table with a `dim` column + HNSW index.
 *
 * Implementations SHOULD NOT throw when a caller looks up a dimension with
 * no rows — return an empty array. They MUST throw when asked to store a
 * vector whose `embedding.length !== dimensions`.
 */
export interface VectorStoreCapability {
  /** Insert or replace a vector keyed by (sessionId, pluginId, namespace, key). */
  upsertVector(input: UpsertVectorInput): Promise<void>;
  /** Top-k nearest neighbours for a query within a single dimension space. */
  searchVectors(input: SearchVectorsInput): Promise<VectorSearchResult[]>;
  /** Bulk delete by scope. */
  deleteVectors(input: DeleteVectorsInput): Promise<void>;
}

/**
 * Type guard — returns true if the store also implements
 * VectorStoreCapability. Callers should branch on this rather than relying
 * on backend-specific imports.
 */
export function supportsVector(
  store: DataStore,
): store is DataStore & VectorStoreCapability {
  const candidate = store as Partial<VectorStoreCapability>;
  return (
    typeof candidate.upsertVector === "function" &&
    typeof candidate.searchVectors === "function" &&
    typeof candidate.deleteVectors === "function"
  );
}
