/**
 * pgvector VectorStoreCapability + VectorModelOps implementation for PgStore.
 *
 * Architecture mirrors sqlite-vector.ts: two-layer design.
 *
 * Layer 1 — Model Router (VectorModelOps):
 *   - `vector_models` table: registry of known embedding models.
 *   - Each model gets one physical table `vec_mem_m{id}` with an HNSW index.
 *   - `sessions.embedding_model_id` FK locks a session to one model.
 *
 * Layer 2 — Physical Table CRUD (VectorStoreCapability):
 *   - `upsertVector`: ON CONFLICT DO UPDATE.
 *   - `searchVectors`: ORDER BY embedding <-> $1 LIMIT k.
 *   - `deleteVectors`: DELETE WHERE scope.
 *
 * Physical table schema (per model):
 *   CREATE TABLE vec_mem_m{id} (
 *     id SERIAL PRIMARY KEY,
 *     session_id TEXT NOT NULL,
 *     plugin_id TEXT NOT NULL,
 *     namespace TEXT NOT NULL,
 *     key TEXT NOT NULL,
 *     embedding vector({dim}) NOT NULL,
 *     payload TEXT,
 *     created_at TIMESTAMPTZ DEFAULT NOW(),
 *     UNIQUE (session_id, plugin_id, namespace, key)
 *   );
 *
 * Schema ownership
 * ────────────────
 * The `vector_models` table and `sessions.embedding_model_id` column are
 * created by `pg-store-mappers.ts`. This module enables the optional vector
 * extension and creates physical tables atomically with registry publication.
 */

import type { Sql, TransactionSql } from "postgres";

import type {
  VectorStoreCapability,
  VectorModelOps,
  EmbeddingModelIdentity,
  VectorTarget,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
  VectorIndexProgressScope,
  CommitVectorIndexBatchInput,
} from "../vector-store.js";
import { normalizeVectorTopK } from "../vector-store.js";
import { assertStoreIdentifiers, withoutNul } from "../common/without-nul.js";

// ── Safety helpers ───────────────────────────────────────────────

function assertValidId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`pg-vector: invalid model registry id ${id}`);
  }
}

function physicalTableName(id: number): string {
  assertValidId(id);
  return `vec_mem_m${id}`;
}

function requireCurrentTableName(id: number, tableName: string): string {
  const expected = physicalTableName(id);
  if (tableName !== expected) {
    throw new Error(
      `pg-vector: vector_models.id ${id} violates the current table_name invariant`,
    );
  }
  return expected;
}

/** Serialize a Float32Array for pgvector: "[v1,v2,...,vn]" */
function toVectorString(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Build the vector capability. Non-vector deployments can boot without
 * pgvector; first model initialization verifies extension availability.
 */
export function createPgVectorCapability(
  client: Sql,
): VectorStoreCapability & VectorModelOps {
  // Model rows are immutable and safe to cache. Session bindings are not
  // cached: another Pod may delete/recreate the same session id, and a stale
  // positive cache would route the new incarnation into the old model/table.
  const modelCache = new Map<number, VectorTarget>();
  // ── Physical table management ────────────────────────────────────

  async function ensurePhysicalTable(
    client: TransactionSql,
    target: VectorTarget,
  ): Promise<void> {
    await client.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
    const tname = physicalTableName(target.modelRegistryId);

    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS ${tname} (
        id         SERIAL PRIMARY KEY,
        session_id TEXT    NOT NULL,
        plugin_id  TEXT    NOT NULL,
        namespace  TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        embedding  vector(${target.dim}) NOT NULL,
        payload    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (session_id, plugin_id, namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_${tname}_session
        ON ${tname} (session_id, plugin_id, namespace);
    `);
  }

  // ── VectorModelOps ───────────────────────────────────────────────

  async function ensureVectorModel(
    identity: EmbeddingModelIdentity,
  ): Promise<VectorTarget> {
    const target = await client.begin(async (tx) => {
      // Serialize extension/table initialization across models and processes.
      await tx`SELECT pg_advisory_xact_lock(hashtext('covel:vector-model-initialization'))`;
      const now = Date.now();

      // INSERT ON CONFLICT DO NOTHING — table_name is left to its DEFAULT
      // ''; the schema-side BEFORE INSERT trigger backfills it from NEW.id
      // before the row hits the table. UNIQUE(model_id, dim) makes
      // concurrent inserts safe.
      await tx`
      INSERT INTO vector_models (model_id, provider, model_name, dim, created_at)
      VALUES (${identity.modelId}, ${identity.provider}, ${identity.modelName}, ${identity.dim}, ${now})
      ON CONFLICT (model_id, dim) DO NOTHING
    `;

      // Read back the canonical row. By the time we get here the trigger
      // has populated table_name.
      const rows = await tx<
        Array<{
          id: number;
          model_id: string;
          provider: string;
          model_name: string;
          dim: number;
          table_name: string;
          created_at: string;
          last_used_at: string | null;
        }>
      >`
      SELECT id, model_id, provider, model_name, dim, table_name, created_at, last_used_at
        FROM vector_models
       WHERE model_id = ${identity.modelId} AND dim = ${identity.dim}
    `;

      if (rows.length === 0) {
        throw new Error(
          `pg-vector: failed to find or create vector_models entry for ${identity.modelId}`,
        );
      }

      const row = rows[0];

      const target: VectorTarget = {
        modelRegistryId: row.id,
        modelId: row.model_id,
        dim: row.dim,
        tableName: requireCurrentTableName(row.id, row.table_name),
      };

      await ensurePhysicalTable(tx, target);
      return target;
    });
    // Publish only after both registry and physical DDL have committed.
    modelCache.set(target.modelRegistryId, target);
    return target;
  }

  async function lockSessionEmbeddingModel(
    sessionId: string,
    target: VectorTarget,
  ): Promise<void> {
    const now = new Date().toISOString();
    const updated = await client<Array<{ id: string }>>`
      UPDATE sessions
         SET embedding_model_id = ${target.modelRegistryId},
             embedding_locked_at = ${now}
       WHERE id = ${sessionId}
         AND embedding_model_id IS NULL
       RETURNING id
    `;
    if (updated.length === 1) {
      return;
    }

    // The conditional update distinguishes a missing session from a lock that
    // another connection won. PostgreSQL re-checks the WHERE predicate after
    // waiting on a concurrent row lock, so exactly one first writer succeeds.
    const rows = await client<Array<{ embedding_model_id: number | null }>>`
      SELECT embedding_model_id
        FROM sessions
       WHERE id = ${sessionId}
    `;
    if (rows.length === 0) {
      throw new Error(
        `pg-vector lockSessionEmbeddingModel: session ${sessionId} not found`,
      );
    }
    throw new Error(
      `pg-vector lockSessionEmbeddingModel: session ${sessionId} is already locked to model ${rows[0].embedding_model_id}`,
    );
  }

  async function resolveSessionVectorTarget(
    sessionId: string,
  ): Promise<VectorTarget | null> {
    const sessionRows = await client<
      Array<{ embedding_model_id: number | null }>
    >`
      SELECT embedding_model_id FROM sessions WHERE id = ${sessionId}
    `;

    if (sessionRows.length === 0 || sessionRows[0].embedding_model_id == null) {
      // An unlocked session can be locked by another server instance at any
      // time. Caching null would make this process permanently miss that
      // immutable transition because only the winning instance can invalidate
      // its local cache.
      return null;
    }

    const modelId = sessionRows[0].embedding_model_id;

    // Try in-memory model cache first.
    const cached = modelCache.get(modelId);
    if (cached) {
      return cached;
    }

    const modelRows = await client<
      Array<{
        id: number;
        model_id: string;
        provider: string;
        model_name: string;
        dim: number;
        table_name: string;
      }>
    >`
      SELECT id, model_id, provider, model_name, dim, table_name
        FROM vector_models
       WHERE id = ${modelId}
    `;

    if (modelRows.length === 0) {
      throw new Error(
        `pg-vector: session ${sessionId} references unknown vector_models.id ${modelId}`,
      );
    }

    const row = modelRows[0];
    const target: VectorTarget = {
      modelRegistryId: row.id,
      modelId: row.model_id,
      dim: row.dim,
      tableName: requireCurrentTableName(row.id, row.table_name),
    };

    modelCache.set(target.modelRegistryId, target);

    return target;
  }

  async function listVectorModels(): Promise<
    Array<
      EmbeddingModelIdentity & {
        id: number;
        tableName: string;
        createdAt: number;
        lastUsedAt: number | null;
      }
    >
  > {
    const rows = await client<
      Array<{
        id: number;
        model_id: string;
        provider: string;
        model_name: string;
        dim: number;
        table_name: string;
        created_at: string;
        last_used_at: string | null;
      }>
    >`
      SELECT id, model_id, provider, model_name, dim, table_name, created_at, last_used_at
        FROM vector_models
       ORDER BY id
    `;

    return rows.map((r) => ({
      id: r.id,
      modelId: r.model_id,
      provider: r.provider,
      modelName: r.model_name,
      dim: r.dim,
      tableName: requireCurrentTableName(r.id, r.table_name),
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at !== null ? Number(r.last_used_at) : null,
    }));
  }

  // ── VectorStoreCapability ────────────────────────────────────────

  async function upsertVector(input: UpsertVectorInput): Promise<void> {
    await client.begin((tx) => upsertVectorInTransaction(tx, input));
  }

  async function upsertVectorInTransaction(
    tx: TransactionSql,
    input: UpsertVectorInput,
  ): Promise<void> {
    assertStoreIdentifiers(input);
    input = withoutNul(input);
    // The extension and physical tables are created by ensureVectorModel. Do
    // not resolve a session binding here: the binding, model row, incarnation
    // guard, and INSERT must all be observed under one parent-row lock.
    const vecStr = toVectorString(input.embedding);

    // Pair with deletePgSessionCascade's parent FOR UPDATE lock. Resolving
    // the target only after this lock removes the resolve/delete/recreate
    // ABA window, while expectedSessionCreatedAt rejects results produced
    // for an older incarnation of the same id.
    const sessionRows = await tx<
      Array<{ embedding_model_id: number | null; created_at: string }>
    >`
        SELECT embedding_model_id, created_at
          FROM sessions
         WHERE id = ${input.sessionId}
         FOR KEY SHARE
      `;
    if (sessionRows.length === 0) {
      throw new Error(
        `pg-vector upsertVector: session ${input.sessionId} not found`,
      );
    }
    const session = sessionRows[0];
    if (
      input.expectedSessionCreatedAt !== undefined &&
      session.created_at !== input.expectedSessionCreatedAt
    ) {
      throw new Error(
        `pg-vector upsertVector: session ${input.sessionId} incarnation changed`,
      );
    }
    if (session.embedding_model_id == null) {
      throw new Error(
        `pg-vector upsertVector: session ${input.sessionId} has no embedding model locked`,
      );
    }

    const modelRows = await tx<
      Array<{
        id: number;
        model_id: string;
        dim: number;
        table_name: string;
      }>
    >`
        SELECT id, model_id, dim, table_name
          FROM vector_models
         WHERE id = ${session.embedding_model_id}
      `;
    if (modelRows.length === 0) {
      throw new Error(
        `pg-vector: session ${input.sessionId} references unknown vector_models.id ${session.embedding_model_id}`,
      );
    }
    const model = modelRows[0];
    const tname = physicalTableName(model.id);
    if (model.table_name !== tname) {
      throw new Error(
        `pg-vector: unsafe vector table name ${JSON.stringify(model.table_name)} for model ${model.id}`,
      );
    }
    if (input.embedding.length !== model.dim) {
      throw new Error(
        `pg-vector upsertVector: embedding length ${input.embedding.length} does not match model dim ${model.dim}`,
      );
    }

    modelCache.set(model.id, {
      modelRegistryId: model.id,
      modelId: model.model_id,
      dim: model.dim,
      tableName: model.table_name,
    });

    await tx.unsafe(
      `INSERT INTO ${tname} (session_id, plugin_id, namespace, key, embedding, payload)
         VALUES ($1, $2, $3, $4, $5::vector, $6)
         ON CONFLICT (session_id, plugin_id, namespace, key)
         DO UPDATE SET embedding = EXCLUDED.embedding, payload = EXCLUDED.payload`,
      [
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
        vecStr,
        input.payload ?? null,
      ],
    );
  }

  async function searchVectors(
    input: SearchVectorsInput,
  ): Promise<VectorSearchResult[]> {
    const topK = normalizeVectorTopK(input.topK);
    if (topK === 0) return [];
    const target = await resolveSessionVectorTarget(input.sessionId);
    if (!target) {
      // No embedding model locked → return empty results.
      return [];
    }

    if (input.query.length !== target.dim) {
      throw new Error(
        `pg-vector searchVectors: query length ${input.query.length} does not match model dim ${target.dim}`,
      );
    }

    const tname = physicalTableName(target.modelRegistryId);
    const vecStr = toVectorString(input.query);

    // Build conditional WHERE clauses.
    const extraClauses: string[] = [`session_id = $2`];
    const extraParams: Array<string | number> = [input.sessionId];
    let paramIdx = 3;

    if (input.pluginId !== undefined) {
      extraClauses.push(`plugin_id = $${paramIdx++}`);
      extraParams.push(input.pluginId);
    }
    if (input.namespace !== undefined) {
      extraClauses.push(`namespace = $${paramIdx++}`);
      extraParams.push(input.namespace);
    }

    const whereSql = extraClauses.join(" AND ");
    const rows = (await client.unsafe(
      `WITH candidates AS MATERIALIZED (
         SELECT session_id, plugin_id, namespace, key, payload, embedding
           FROM ${tname} WHERE ${whereSql}
       )
       SELECT session_id, plugin_id, namespace, key, payload,
              embedding <-> $1::vector AS distance
         FROM candidates
        ORDER BY distance, plugin_id COLLATE "C", namespace COLLATE "C", key COLLATE "C"
        LIMIT $${paramIdx}`,
      [vecStr, ...extraParams, topK],
    )) as Array<{
      session_id: string;
      plugin_id: string;
      namespace: string;
      key: string;
      payload: string | null;
      distance: number;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      pluginId: r.plugin_id,
      namespace: r.namespace,
      key: r.key,
      distance: r.distance,
      payload: r.payload,
    }));
  }

  async function getVectorIndexProgress(
    scope: VectorIndexProgressScope,
  ): Promise<string | null> {
    const rows = await client<Array<{ value: string }>>`
      SELECT value FROM vector_index_progress
      WHERE session_id = ${scope.sessionId} AND plugin_id = ${scope.pluginId} AND namespace = ${scope.namespace}
    `;
    return rows[0]?.value ?? null;
  }

  async function commitVectorIndexBatch(
    input: CommitVectorIndexBatchInput,
  ): Promise<boolean> {
    return client.begin(async (tx) => {
      // The parent lock pairs with session cascade deletion, including same-id replacement.
      const sessions = await tx<
        Array<{ created_at: string; embedding_model_id: number | null }>
      >`
        SELECT created_at, embedding_model_id FROM sessions WHERE id = ${input.sessionId} FOR KEY SHARE
      `;
      if (
        !sessions[0] ||
        sessions[0].created_at !== input.expectedSessionCreatedAt
      ) {
        throw new Error("Vector index progress: session incarnation changed");
      }
      // Claim progress first. PostgreSQL rechecks the predicate after waiting
      // for a competing writer; the loser never reaches vector mutations.
      const rows =
        input.expectedValue === null
          ? await tx`
            INSERT INTO vector_index_progress (session_id, plugin_id, namespace, value)
            VALUES (${input.sessionId}, ${input.pluginId}, ${input.namespace}, ${input.value})
            ON CONFLICT DO NOTHING RETURNING session_id
          `
          : await tx`
            UPDATE vector_index_progress SET value = ${input.value}
            WHERE session_id = ${input.sessionId} AND plugin_id = ${input.pluginId}
              AND namespace = ${input.namespace} AND value = ${input.expectedValue}
            RETURNING session_id
          `;
      if (rows.length === 0) return false;
      const modelId = sessions[0].embedding_model_id;
      if (input.deletes?.length && modelId !== null) {
        const models = await tx<Array<{ id: number; table_name: string }>>`
          SELECT id, table_name FROM vector_models WHERE id = ${modelId}
        `;
        if (!models[0]) {
          throw new Error(
            `pg-vector: session ${input.sessionId} references unknown vector_models.id ${modelId}`,
          );
        }
        const tname = requireCurrentTableName(
          models[0].id,
          models[0].table_name,
        );
        for (const mutation of input.deletes) {
          await tx.unsafe(
            `DELETE FROM ${tname} WHERE session_id = $1 AND plugin_id = $2 AND namespace = $3 AND key = $4`,
            [input.sessionId, input.pluginId, mutation.namespace, mutation.key],
          );
        }
      }
      for (const mutation of input.upserts ?? []) {
        await upsertVectorInTransaction(tx, {
          ...mutation,
          sessionId: input.sessionId,
          pluginId: input.pluginId,
          expectedSessionCreatedAt: input.expectedSessionCreatedAt,
        });
      }
      return true;
    });
  }

  async function deleteVectors(input: DeleteVectorsInput): Promise<void> {
    const target = await resolveSessionVectorTarget(input.sessionId);
    if (!target) {
      // No embedding model — nothing to delete.
      return;
    }

    const tname = physicalTableName(target.modelRegistryId);

    const conditions = ["session_id = $1", "plugin_id = $2"];
    const values = [input.sessionId, input.pluginId];
    if (input.namespace !== undefined) {
      values.push(input.namespace);
      conditions.push(`namespace = $${values.length}`);
    }
    if (input.key !== undefined) {
      values.push(input.key);
      conditions.push(`key = $${values.length}`);
    }
    await client.begin(async (tx) => {
      const sessions = await tx<
        Array<{ created_at: string; embedding_model_id: number | null }>
      >`
        SELECT created_at, embedding_model_id FROM sessions WHERE id = ${input.sessionId} FOR KEY SHARE
      `;
      const session = sessions[0];
      if (
        !session ||
        session.embedding_model_id !== target.modelRegistryId ||
        (input.expectedSessionCreatedAt !== undefined &&
          session.created_at !== input.expectedSessionCreatedAt)
      ) {
        throw new Error("Vector delete: session incarnation changed");
      }
      await tx.unsafe(
        `DELETE FROM ${tname} WHERE ${conditions.join(" AND ")}`,
        values,
      );
    });
  }

  return {
    getVectorIndexProgress,
    commitVectorIndexBatch,
    upsertVector,
    searchVectors,
    deleteVectors,
    ensureVectorModel,
    lockSessionEmbeddingModel,
    resolveSessionVectorTarget,
    listVectorModels,
  };
}
