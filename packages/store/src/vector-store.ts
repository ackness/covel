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
 * Phase 1: Per embedding model, vectors have a fixed dimension. Each
 * embedding model gets its own physical table (`vec_mem_m{id}`), isolated
 * via the `vector_models` registry. Sessions lock to one embedding model at
 * creation time; that lock is immutable for the session's lifetime.
 *
 * Metadata filtering uses the same quadruple as `plugin_data`:
 *   `(sessionId, pluginId, namespace, key)`
 * plus an optional free-text `payload` column so callers can round-trip
 * the original chunk without a separate join to `plugin_data`.
 *
 * Vectors are passed as `Float32Array` — frontends should convert from
 * `number[]` once, not per call.
 */

import type { DataStore } from "./types.js";

// ── Model identity & routing ─────────────────────────────────────

/** Identity of an embedding model. Used as routing key. */
export interface EmbeddingModelIdentity {
  readonly provider: string; // "openai", "ollama", etc.
  readonly modelName: string; // "text-embedding-3-small"
  readonly dim: number; // 1536, 768, 3072, etc.
  /** Normalized: "${provider}/${modelName}" */
  readonly modelId: string;
}

/** A resolved vector routing target (what session is locked to). */
export interface VectorTarget {
  readonly modelRegistryId: number; // vector_models.id
  readonly modelId: string;
  readonly dim: number;
  readonly tableName: string; // "vec_mem_m{id}"
}

// ── CRUD inputs ──────────────────────────────────────────────────

/**
 * Request to upsert a single vector. The quadruple
 * `(sessionId, pluginId, namespace, key)` uniquely identifies a row —
 * re-upserting with the same quadruple replaces the embedding and payload.
 *
 * The dimension is determined by the session's locked embedding model —
 * callers do not specify it. If `embedding.length` mismatches the model's
 * declared dim, the backend throws.
 */
export interface UpsertVectorInput {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  /** L2-normalized or raw embedding, per the caller's embedding model. */
  readonly embedding: Float32Array;
  /**
   * Optional round-trip payload — the original text chunk, a JSON blob,
   * etc. Returned verbatim by `searchVectors`. Backends store it alongside
   * the vector so KNN results do not require a JOIN to plugin_data.
   */
  readonly payload?: string;
}

/** Request to run a KNN search against the session's vector space. */
export interface SearchVectorsInput {
  readonly sessionId: string;
  readonly query: Float32Array;
  /** Top-k cap. Default: 8. Typical range: 3–30. */
  readonly topK?: number;
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
}

// ── Capability interfaces ────────────────────────────────────────

/**
 * Core vector CRUD operations. Session embedding model must be locked
 * before calling any of these methods.
 */
export interface VectorStoreCapability {
  /** Insert or replace a vector keyed by (sessionId, pluginId, namespace, key). */
  upsertVector(input: UpsertVectorInput): Promise<void>;
  /** Top-k nearest neighbours for a query within the session's vector space. */
  searchVectors(input: SearchVectorsInput): Promise<VectorSearchResult[]>;
  /** Bulk delete by scope. */
  deleteVectors(input: DeleteVectorsInput): Promise<void>;
}

/** Operations for managing the vector_models registry and session embedding locks. */
export interface VectorModelOps {
  /**
   * Register (or get existing) an embedding model.
   * Creates physical table if not yet existing.
   * Returns the model registry entry.
   */
  ensureVectorModel(identity: EmbeddingModelIdentity): Promise<VectorTarget>;

  /**
   * Lock a session's embedding model. One-time write only.
   * Throws if session already has a lock.
   */
  lockSessionEmbeddingModel(
    sessionId: string,
    target: VectorTarget,
  ): Promise<void>;

  /**
   * Resolve the vector routing target for a session.
   * Returns null if session has no embedding model (RAG disabled).
   */
  resolveSessionVectorTarget(sessionId: string): Promise<VectorTarget | null>;

  /** Get all registered vector models and their physical tables. */
  listVectorModels(): Promise<
    Array<
      EmbeddingModelIdentity & {
        id: number;
        tableName: string;
        createdAt: number;
        lastUsedAt: number | null;
      }
    >
  >;
}

// ── Type guard ───────────────────────────────────────────────────

/**
 * Type guard — returns true if the store also implements
 * VectorStoreCapability and VectorModelOps. Callers should branch on
 * this rather than relying on backend-specific imports.
 */
export function supportsVector(
  store: DataStore,
): store is DataStore & VectorStoreCapability & VectorModelOps {
  const candidate = store as Partial<VectorStoreCapability & VectorModelOps>;
  return (
    typeof candidate.upsertVector === "function" &&
    typeof candidate.searchVectors === "function" &&
    typeof candidate.deleteVectors === "function" &&
    typeof candidate.ensureVectorModel === "function" &&
    typeof candidate.resolveSessionVectorTarget === "function"
  );
}

/**
 * Vector backend selector and the composed vector-store shape.
 * Production discovers vector support via `supportsVector(store)` directly
 * (see vector-store.ts) — there is no runtime vector-store factory.
 */
export type VectorBackend = "embedded" | "none" | "external";
export type VectorStore = VectorStoreCapability & VectorModelOps;
