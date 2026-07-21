/**
 * Embedding-lock helper.
 *
 * Resolves the embed slot, probes its output dimension on first use, and
 * locks the session row to a `vector_models` registry entry. After this
 * runs once per session, all `store.upsertVector()` / `searchVectors()`
 * calls route to the right per-model physical table automatically.
 *
 * Why "lazy lock at first turn" instead of "lock at session create":
 * - `POST /api/sessions` may be called without API keys; the embedding
 *   probe needs them to call `gateway.embed`. Deferring the lock to the
 *   first action call (which always carries keys via the bound adapter)
 *   keeps session creation free of LLM-config coupling.
 * - Sessions that never trigger RAG never pay the probe cost.
 *
 * Concurrency: the per-session promise cache below collapses parallel
 * first-action calls into one probe. The store layer's `vector_models`
 * UNIQUE(model_id, dim) constraint makes the database write idempotent
 * even across processes.
 *
 * Once `sessions.embedding_model_id` is set, `lockSessionEmbeddingModel`
 * throws on re-lock attempts (ADR-005), so duplicate calls are safe.
 */

import type {
  DataStore,
  EmbeddingModelIdentity,
  VectorTarget,
} from "@covel/store";
import { supportsVector } from "@covel/store";
import type { AiStack } from "./ai-setup.js";

interface CachedDim {
  dim: number;
  modelId: string;
}

/** Build a session-locking helper bound to a specific store + AI stack. */
export function createEmbeddingLockHelper(opts: {
  store: DataStore;
  ai: AiStack;
  /**
   * API keys to pass to the embedding probe. Should match the same keys
   * the runtime uses for chat calls. In practice the server boot path
   * supplies env-derived keys; per-request key overrides are not yet
   * supported on this hot path.
   */
  apiKeys?: Record<string, string>;
}): (sessionId: string) => Promise<void> {
  const { store, ai, apiKeys } = opts;

  // Per-session promise cache — collapses concurrent first-turn calls.
  const inflight = new Map<string, Promise<VectorTarget | null>>();
  // (provider, modelName) → cached dim — avoids re-probing the same
  // embedding model across sessions.
  const dimCache = new Map<string, CachedDim>();

  async function probeDimension(
    provider: string,
    modelName: string,
  ): Promise<CachedDim | null> {
    const cacheKey = `${provider}/${modelName}`;
    const cached = dimCache.get(cacheKey);
    if (cached) return cached;

    try {
      const result = await ai.gateway.embed(
        { values: ["covel-embed-probe"] },
        // Boot-path keys are env-derived → origin-gated channel.
        apiKeys ? { envApiKeys: apiKeys } : undefined,
      );
      const vector = result.embeddings?.[0];
      if (!Array.isArray(vector) || vector.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[embedding-lock] embed probe for ${cacheKey} returned no vector`,
        );
        return null;
      }
      const entry: CachedDim = { dim: vector.length, modelId: cacheKey };
      dimCache.set(cacheKey, entry);
      return entry;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[embedding-lock] embed probe failed for ${cacheKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async function lockOnce(sessionId: string): Promise<VectorTarget | null> {
    if (!supportsVector(store)) return null;

    // Already locked? Fast path.
    const existing = await store.resolveSessionVectorTarget(sessionId);
    if (existing) return existing;

    // Find the embed slot. Throws when none configured — treat as RAG off.
    let target;
    try {
      target = ai.presetRegistry.resolveEmbeddingTarget();
    } catch {
      return null;
    }

    const provider = target.profile.provider;
    const modelName = target.profile.model;

    const probed = await probeDimension(provider, modelName);
    if (!probed) return null;

    const identity: EmbeddingModelIdentity = {
      provider,
      modelName,
      dim: probed.dim,
      modelId: `${provider}/${modelName}`,
    };

    const vt = await store.ensureVectorModel(identity);
    try {
      await store.lockSessionEmbeddingModel(sessionId, vt);
    } catch (err) {
      // Race: another concurrent call may have locked first. Re-resolve
      // and trust whatever is now persisted on the session row.
      const reread = await store.resolveSessionVectorTarget(sessionId);
      if (reread) return reread;
      throw err;
    }
    return vt;
  }

  return async (sessionId: string): Promise<void> => {
    const pending = inflight.get(sessionId);
    if (pending) {
      await pending;
      return;
    }
    const promise = lockOnce(sessionId).finally(() => {
      inflight.delete(sessionId);
    });
    inflight.set(sessionId, promise);
    await promise;
  };
}
