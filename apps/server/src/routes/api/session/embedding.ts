import { supportsVector } from "@covel/store";
import type { DataStore, SessionRecord } from "@covel/store";

interface SessionEmbeddingInfo {
  modelId: string;
  provider: string;
  modelName: string;
  dim: number;
  lockedAt: string | null;
}

/**
 * Decorate a SessionRecord with the embedding model lock metadata.
 *
 * The session row only stores the registry id (`embeddingModelId`); the
 * UI needs the full identity to render a "session locked to model X"
 * indicator. We resolve the lazy join here rather than denormalising
 * into the sessions table to keep the storage model simple.
 */
export async function withEmbeddingMetadata(
  store: DataStore,
  session: SessionRecord,
): Promise<SessionRecord & { embedding?: SessionEmbeddingInfo | null }> {
  if (!supportsVector(store) || session.embeddingModelId == null) {
    return session;
  }
  try {
    const models = await store.listVectorModels();
    const match = models.find((m) => m.id === session.embeddingModelId);
    if (!match) return session;
    return {
      ...session,
      embedding: {
        modelId: match.modelId,
        provider: match.provider,
        modelName: match.modelName,
        dim: match.dim,
        lockedAt: session.embeddingLockedAt ?? null,
      },
    };
  } catch {
    return session;
  }
}

/**
 * Bulk-decorate a session list with embedding metadata.
 *
 * Resolves all `vector_models` rows once and joins in memory, so a list
 * of N sessions costs one extra DB call instead of N. Sessions without a
 * lock pass through untouched.
 */
export async function decorateSessionList(
  store: DataStore,
  sessions: readonly SessionRecord[],
): Promise<SessionRecord[]> {
  if (!supportsVector(store) || sessions.length === 0) {
    return sessions.slice();
  }
  const anyLocked = sessions.some((s) => s.embeddingModelId != null);
  if (!anyLocked) return sessions.slice();
  let models: Awaited<ReturnType<typeof store.listVectorModels>>;
  try {
    models = await store.listVectorModels();
  } catch {
    return sessions.slice();
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  return sessions.map((session) => {
    if (session.embeddingModelId == null) return session;
    const match = byId.get(session.embeddingModelId);
    if (!match) return session;
    return {
      ...session,
      embedding: {
        modelId: match.modelId,
        provider: match.provider,
        modelName: match.modelName,
        dim: match.dim,
        lockedAt: session.embeddingLockedAt ?? null,
      } satisfies SessionEmbeddingInfo,
    };
  });
}
