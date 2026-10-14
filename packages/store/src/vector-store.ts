/**
 * Optional vector-search capability for stores that support it.
 *
 * This is intentionally NOT part of the core DataStore contract — not every
 * backend needs to implement ANN/brute-force vector search; BrowserVault is
 * intentionally outside this server-side capability. Stores declare support
 * by implementing this interface on top of
 * DataStore; consumers check via `supportsVector()` before using it.
 *
 * Design notes
 * ------------
 *
 * Phase 1: Per embedding model, vectors have a fixed dimension. Each
 * embedding model gets its own physical table (`vec_mem_m{id}`), isolated
 * via the `vector_models` registry. A session locks to one embedding model the
 * first time it is indexed. The lock changes only through
 * `resetSessionVectorIndex`, which discards the index built with the old model
 * in the same transaction.
 *
 * Metadata filtering uses the same quadruple as `plugin_data`:
 *   `(sessionId, pluginId, namespace, key)`
 * plus an optional free-text `payload` column so callers can round-trip
 * the original chunk without a separate join to `plugin_data`.
 *
 * Vectors are passed as `Float32Array` — frontends should convert from
 * `number[]` once, not per call.
 */

// ── Model identity & routing ─────────────────────────────────────

/** Identity of an embedding model. Used as routing key. */
export interface EmbeddingModelIdentity {
  readonly provider: string; // "openai", "ollama", etc.
  readonly modelName: string; // "text-embedding-3-small"
  readonly dim: number; // 1536, 768, 3072, etc.
  /** Opaque routing identity; server locks include an endpoint/protocol/format hash. */
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
  /**
   * Optional session-incarnation guard. When present, the backend rejects the
   * write unless the current session row has this exact `createdAt` value.
   * Callers that perform embedding work asynchronously should capture the
   * value before starting that work so a delete/recreate of the same session
   * id cannot receive a stale result.
   */
  readonly expectedSessionCreatedAt?: string;
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

/** Normalize the backend-independent top-k contract before issuing a query. */
export function normalizeVectorTopK(topK: number | undefined): number {
  const value = topK ?? 8;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("vector search topK must be a safe integer");
  }
  return value <= 0 ? 0 : value;
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

/** Point read of stored vectors by key, within one plugin namespace. */
export interface GetVectorPayloadsInput {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly keys: readonly string[];
}

/** Scope for bulk deletion. Omit fields to widen the scope. */
export interface DeleteVectorsInput {
  readonly sessionId: string;
  /** Reject deletion produced from a stale session incarnation. */
  readonly expectedSessionCreatedAt?: string;
  /** Required — prevents cross-plugin accidental deletion. */
  readonly pluginId: string;
  /** Optional — when omitted, wipes every namespace for the plugin. */
  readonly namespace?: string;
  /** Delete just this key within the selected scope. */
  readonly key?: string;
}

/** Derived index progress belongs to the index, never to exported plugin data. */
export interface VectorIndexProgressScope {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
}

export interface CommitVectorIndexBatchInput extends VectorIndexProgressScope {
  readonly value: string;
  readonly expectedValue: string | null;
  readonly expectedSessionCreatedAt: string;
  /**
   * The model registry id the batch was embedded with. When present, the
   * backend rejects the batch (throws) unless the session is still locked to
   * it, so vectors from a model the index was reset away from never land.
   */
  readonly expectedModelRegistryId?: number;
  readonly upserts?: readonly Pick<
    UpsertVectorInput,
    "namespace" | "key" | "embedding" | "payload"
  >[];
  readonly deletes?: readonly Pick<UpsertVectorInput, "namespace" | "key">[];
}

/** Move a session's vector index to another embedding model. */
export interface ResetSessionVectorIndexInput {
  readonly sessionId: string;
  /** Reject a reset planned against an older incarnation of the session id. */
  readonly expectedSessionCreatedAt: string;
  /** The model registry id the caller saw locked; null when it saw none. */
  readonly expectedModelRegistryId: number | null;
  /** The model to lock the session to; null leaves the session unlocked. */
  readonly target: VectorTarget | null;
}

// ── Capability interfaces ────────────────────────────────────────

/**
 * Core vector CRUD operations. Session embedding model must be locked
 * before calling any of these methods.
 */
export interface VectorStoreCapability {
  getVectorIndexProgress(
    scope: VectorIndexProgressScope,
  ): Promise<string | null>;
  /**
   * Atomically commit deletes, then upserts, and index progress. A CAS conflict
   * returns false without mutation. Stale incarnations or invalid mutations
   * throw and roll back the entire batch. Mutation namespaces are independent
   * of the progress namespace; sessionId and pluginId apply to the whole batch.
   */
  commitVectorIndexBatch(input: CommitVectorIndexBatchInput): Promise<boolean>;
  /** Insert or replace a vector keyed by (sessionId, pluginId, namespace, key). */
  upsertVector(input: UpsertVectorInput): Promise<void>;
  /** Top-k nearest neighbours for a query within the session's vector space. */
  searchVectors(input: SearchVectorsInput): Promise<VectorSearchResult[]>;
  /**
   * The payloads of the stored vectors among `keys`, keyed by key. A key with
   * no vector is absent. Lets an indexer skip a record whose text it already
   * embedded without keeping its own copy of what the index holds.
   */
  getVectorPayloads(
    input: GetVectorPayloadsInput,
  ): Promise<Map<string, string | null>>;
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
   * Discard a session's vector index and lock it to another model, in one
   * transaction: every vector the session has under its current model and all
   * of its index progress are deleted, then the lock is set to `target` (or
   * cleared when `target` is null). Returns false and changes nothing when the
   * session is no longer locked to `expectedModelRegistryId`. Throws when the
   * session is missing or is another incarnation.
   */
  resetSessionVectorIndex(
    input: ResetSessionVectorIndexInput,
  ): Promise<boolean>;

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
export function supportsVector<T extends object>(
  store: T,
): store is T & VectorStoreCapability & VectorModelOps {
  const candidate = store as Partial<VectorStoreCapability & VectorModelOps>;
  return (
    typeof candidate.upsertVector === "function" &&
    typeof candidate.searchVectors === "function" &&
    typeof candidate.getVectorPayloads === "function" &&
    typeof candidate.deleteVectors === "function" &&
    typeof candidate.getVectorIndexProgress === "function" &&
    typeof candidate.commitVectorIndexBatch === "function" &&
    typeof candidate.lockSessionEmbeddingModel === "function" &&
    typeof candidate.resetSessionVectorIndex === "function" &&
    typeof candidate.ensureVectorModel === "function" &&
    typeof candidate.resolveSessionVectorTarget === "function" &&
    typeof candidate.listVectorModels === "function"
  );
}

/**
 * Vector backend selector and the composed vector-store shape.
 * Production discovers vector support via `supportsVector(store)` directly
 * (see vector-store.ts) — there is no runtime vector-store factory.
 */
export type VectorBackend = "embedded" | "none" | "external";
export type VectorStore = VectorStoreCapability & VectorModelOps;
