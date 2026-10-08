import { vectorRowKey } from "../common/keys.js";
import type {
  DeleteVectorsInput,
  EmbeddingModelIdentity,
  SearchVectorsInput,
  UpsertVectorInput,
  VectorSearchResult,
  VectorTarget,
} from "../vector-store.js";
import { normalizeVectorTopK } from "../vector-store.js";
import type {
  MemoryState,
  MemoryStoreMethods,
  MemoryVectorRow,
} from "./memory-types.js";

function l2Distance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function createVectorMethods(state: MemoryState): MemoryStoreMethods {
  function prepareVector(input: UpsertVectorInput) {
    const session = state.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(
        `Memory vector upsert: session ${input.sessionId} not found`,
      );
    }
    if (
      input.expectedSessionCreatedAt !== undefined &&
      session.createdAt !== input.expectedSessionCreatedAt
    ) {
      throw new Error(
        `Memory vector upsert: session ${input.sessionId} incarnation changed`,
      );
    }
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
    return [
      rowKey,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        namespace: input.namespace,
        key: input.key,
        dim: target.dim,
        embedding: new Float32Array(input.embedding),
        payload: input.payload ?? null,
      },
    ] as const;
  }

  return {
    async getVectorIndexProgress(scope) {
      return (
        state.vectorIndexProgress.get(
          JSON.stringify([scope.sessionId, scope.pluginId, scope.namespace]),
        )?.value ?? null
      );
    },
    async commitVectorIndexBatch(input) {
      const session = state.sessions.get(input.sessionId);
      if (!session || session.createdAt !== input.expectedSessionCreatedAt) {
        throw new Error("Vector index progress: session incarnation changed");
      }
      const key = JSON.stringify([
        input.sessionId,
        input.pluginId,
        input.namespace,
      ]);
      if (
        (state.vectorIndexProgress.get(key)?.value ?? null) !==
        input.expectedValue
      )
        return false;
      // Build every row before touching state: validation or cloning may throw.
      const upserts = (input.upserts ?? []).map((mutation) =>
        prepareVector({
          ...mutation,
          sessionId: input.sessionId,
          pluginId: input.pluginId,
          expectedSessionCreatedAt: input.expectedSessionCreatedAt,
        }),
      );
      const deletes = (input.deletes ?? []).map((mutation) =>
        vectorRowKey(
          input.sessionId,
          input.pluginId,
          mutation.namespace,
          mutation.key,
        ),
      );
      for (const rowKey of deletes) state.vectorRows.delete(rowKey);
      for (const [rowKey, row] of upserts) state.vectorRows.set(rowKey, row);
      state.vectorIndexProgress.set(key, {
        sessionId: input.sessionId,
        value: input.value,
      });
      return true;
    },
    async upsertVector(input: UpsertVectorInput) {
      const [key, row] = prepareVector(input);
      state.vectorRows.set(key, row);
    },

    async searchVectors(
      input: SearchVectorsInput,
    ): Promise<VectorSearchResult[]> {
      const topK = normalizeVectorTopK(input.topK);
      if (topK === 0) return [];
      const target = state.sessionVectorTargets.get(input.sessionId) ?? null;
      if (!target) {
        return [];
      }
      if (input.query.length !== target.dim) {
        throw new Error(
          `Memory vector search: query length ${input.query.length} does not match model dim ${target.dim}`,
        );
      }
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
        scored.push({ row, distance: l2Distance(input.query, row.embedding) });
      }
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, topK).map(({ row, distance }) => ({
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        namespace: row.namespace,
        key: row.key,
        distance,
        payload: row.payload,
      }));
    },

    async deleteVectors(input: DeleteVectorsInput) {
      if (
        input.expectedSessionCreatedAt !== undefined &&
        state.sessions.get(input.sessionId)?.createdAt !==
          input.expectedSessionCreatedAt
      ) {
        throw new Error("Vector delete: session incarnation changed");
      }
      for (const [rowKey, row] of Array.from(state.vectorRows.entries())) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.pluginId !== input.pluginId) continue;
        if (
          input.namespace !== undefined &&
          row.namespace !== input.namespace
        ) {
          continue;
        }
        if (input.key !== undefined && row.key !== input.key) continue;
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
