import { vectorRowKey } from "../common/keys.js";
import type {
  DeleteVectorsInput,
  EmbeddingModelIdentity,
  SearchVectorsInput,
  UpsertVectorInput,
  VectorSearchResult,
  VectorTarget,
} from "../vector-store.js";
import type {
  MemoryState,
  MemoryStoreMethods,
  MemoryVectorRow,
} from "./memory-types.js";

function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function createVectorMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async upsertVector(input: UpsertVectorInput) {
      const target = state.sessionVectorTargets.get(input.sessionId) ?? null;
      if (!target) {
        throw new Error(
          `Memory vector upsert: session ${input.sessionId} has no embedding model locked`,
        );
      }
      if (input.embedding.length !== target.dim) {
        throw new Error(
          `Memory vector upsert: embedding length ${input.embedding.length} does not match model dim ${target.dim}`,
        );
      }
      const rowKey = vectorRowKey(
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
      );
      state.vectorRows.set(rowKey, {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        namespace: input.namespace,
        key: input.key,
        dim: target.dim,
        embedding: new Float32Array(input.embedding),
        payload: input.payload ?? null,
      });
    },

    async searchVectors(
      input: SearchVectorsInput,
    ): Promise<VectorSearchResult[]> {
      const target = state.sessionVectorTargets.get(input.sessionId) ?? null;
      if (!target) {
        return [];
      }
      if (input.query.length !== target.dim) {
        throw new Error(
          `Memory vector search: query length ${input.query.length} does not match model dim ${target.dim}`,
        );
      }
      const topK = input.topK ?? 8;
      const scored: Array<{ row: MemoryVectorRow; distance: number }> = [];
      for (const row of state.vectorRows.values()) {
        if (row.sessionId !== input.sessionId) continue;
        if (input.pluginId !== undefined && row.pluginId !== input.pluginId) {
          continue;
        }
        if (
          input.namespace !== undefined &&
          row.namespace !== input.namespace
        ) {
          continue;
        }
        scored.push({ row, distance: squaredL2(input.query, row.embedding) });
      }
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, Math.max(0, topK)).map(({ row, distance }) => ({
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        namespace: row.namespace,
        key: row.key,
        distance,
        payload: row.payload,
      }));
    },

    async deleteVectors(input: DeleteVectorsInput) {
      for (const [rowKey, row] of Array.from(state.vectorRows.entries())) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.pluginId !== input.pluginId) continue;
        if (
          input.namespace !== undefined &&
          row.namespace !== input.namespace
        ) {
          continue;
        }
        state.vectorRows.delete(rowKey);
      }
    },

    async ensureVectorModel(
      identity: EmbeddingModelIdentity,
    ): Promise<VectorTarget> {
      const registryKey = `${identity.modelId}:${identity.dim}`;
      const existing = state.vectorModelRegistry.get(registryKey);
      if (existing) return existing;
      const id = state.nextModelId;
      state.nextModelId += 1;
      const target: VectorTarget = {
        modelRegistryId: id,
        modelId: identity.modelId,
        dim: identity.dim,
        tableName: `vec_mem_m${id}`,
      };
      state.vectorModelRegistry.set(registryKey, target);
      return target;
    },

    async lockSessionEmbeddingModel(
      sessionId: string,
      target: VectorTarget,
    ): Promise<void> {
      const existing = state.sessionVectorTargets.get(sessionId);
      if (existing !== undefined && existing !== null) {
        throw new Error(
          `Memory lockSessionEmbeddingModel: session ${sessionId} is already locked to model ${existing.modelId}`,
        );
      }
      state.sessionVectorTargets.set(sessionId, target);
    },

    async resolveSessionVectorTarget(
      sessionId: string,
    ): Promise<VectorTarget | null> {
      return state.sessionVectorTargets.get(sessionId) ?? null;
    },

    async listVectorModels(): Promise<
      Array<
        EmbeddingModelIdentity & {
          id: number;
          tableName: string;
          createdAt: number;
          lastUsedAt: number | null;
        }
      >
    > {
      return Array.from(state.vectorModelRegistry.values()).map((target) => ({
        id: target.modelRegistryId,
        modelId: target.modelId,
        provider: target.modelId.split("/")[0] ?? target.modelId,
        modelName:
          target.modelId.split("/").slice(1).join("/") || target.modelId,
        dim: target.dim,
        tableName: target.tableName,
        createdAt: 0,
        lastUsedAt: null,
      }));
    },
  };
}
