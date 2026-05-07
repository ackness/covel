/**
 * sqlite-vec VectorStoreCapability + VectorModelOps implementation for
 * SqliteStore.
 *
 * Architecture: Two-layer design
 * ──────────────────────────────
 *
 * Layer 1 — Model Router (VectorModelOps):
 *   - `vector_models` table: registry of known embedding models.
 *   - Each model gets one physical vec0 virtual table: `vec_mem_m{id}`.
 *   - `sessions.embedding_model_id` FK locks a session to one model.
 *   - In-memory caches avoid redundant DB lookups within a process.
 *
 * Layer 2 — Physical Table CRUD (VectorStoreCapability):
 *   - `upsertVector`: resolve session → model table → DELETE+INSERT.
 *   - `searchVectors`: resolve session → KNN query on model table.
 *   - `deleteVectors`: resolve session → DELETE from model table.
 *
 * Physical table schema (sqlite-vec vec0):
 *   CREATE VIRTUAL TABLE vec_mem_m{id} USING vec0(
 *     session_id text partition key,
 *     plugin_id  text,
 *     namespace  text,
 *     data_key   text,
 *     +payload   text,
 *     embedding  float[{dim}]
 *   );
 *
 * Schema ownership
 * ────────────────
 * The `vector_models` table and the `sessions.embedding_model_id` /
 * `embedding_locked_at` columns are created by `sqlite-store-mappers.ts`
 * during store initialization. This module ONLY creates per-model
 * physical vec0 tables on demand — it does not duplicate the registry
 * or session-column DDL.
 *
 * If sqlite-vec fails to load (unsupported platform, missing binary),
 * `createSqliteVectorCapability` returns `null` and the store exposes
 * no vector methods. Callers must branch via `supportsVector()`.
 */

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type {
  VectorStoreCapability,
  VectorModelOps,
  EmbeddingModelIdentity,
  VectorTarget,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from "../vector-store.js";

// ── Safety helpers ───────────────────────────────────────────────

function assertValidId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`sqlite-vec: invalid model registry id ${id}`);
  }
}

function physicalTableName(id: number): string {
  assertValidId(id);
  return `vec_mem_m${id}`;
}

/** Convert a Float32Array to the JSON string form sqlite-vec expects. */
function toJsonVector(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

// ── Row types for raw SQL queries ───────────────────────────────

interface VectorModelRow {
  id: number;
  model_id: string;
  provider: string;
  model_name: string;
  dim: number;
  table_name: string;
  created_at: number;
  last_used_at: number | null;
}

interface SessionEmbeddingRow {
  embedding_model_id: number | null;
  embedding_locked_at: string | null;
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Build the vector capability. Returns null if sqlite-vec cannot be
 * loaded on the current platform — callers should treat vector support
 * as unavailable and fall back to structured retrieval.
 */
export function createSqliteVectorCapability(
  sqlite: Database.Database,
): (VectorStoreCapability & VectorModelOps) | null {
  try {
    sqliteVec.load(sqlite);
  } catch (err) {
    // Loading can fail on unsupported platforms or if the optional
    // dependency is pruned. Downgrade to null rather than crashing.
    // eslint-disable-next-line no-console
    console.warn(
      `[sqlite-store] sqlite-vec unavailable — vector capability disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // NOTE: vector_models table and sessions.embedding_model_id /
  // embedding_locked_at columns are owned by sqlite-store-mappers.ts.
  // We trust they exist by the time this factory runs.

  // ── In-memory caches ────────────────────────────────────────────
  // Keyed by modelRegistryId (number) → VectorTarget
  const modelCache = new Map<number, VectorTarget>();
  // Keyed by sessionId → VectorTarget | null (null = RAG disabled)
  const sessionTargetCache = new Map<string, VectorTarget | null>();
  // Physical table IDs that have already been created in this process.
  const createdTables = new Set<number>();

  // ── Helpers ──────────────────────────────────────────────────────

  function ensurePhysicalTable(target: VectorTarget): void {
    if (createdTables.has(target.modelRegistryId)) return;
    const tname = physicalTableName(target.modelRegistryId);
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tname} USING vec0(
        session_id text partition key,
        plugin_id  text,
        namespace  text,
        data_key   text,
        +payload   text,
        embedding  float[${target.dim}]
      );
    `);
    createdTables.add(target.modelRegistryId);
  }

  function rowToTarget(row: VectorModelRow): VectorTarget {
    return {
      modelRegistryId: row.id,
      modelId: row.model_id,
      dim: row.dim,
      tableName: row.table_name,
    };
  }

  // ── VectorModelOps ───────────────────────────────────────────────

  async function ensureVectorModel(
    identity: EmbeddingModelIdentity,
  ): Promise<VectorTarget> {
    const now = Date.now();

    // INSERT OR IGNORE — table_name is left to its DEFAULT '' so the
    // schema-side AFTER INSERT trigger can backfill it as 'vec_mem_m{id}'
    // atomically. Concurrent startups are safe because UNIQUE(model_id,
    // dim) makes the second writer a no-op.
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO vector_models
          (model_id, provider, model_name, dim, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        identity.modelId,
        identity.provider,
        identity.modelName,
        identity.dim,
        now,
      );

    // Read back the canonical row. By the time we get here the trigger
    // has populated table_name (the trigger runs in the same transaction
    // as the INSERT).
    const row = sqlite
      .prepare(
        `SELECT id, model_id, provider, model_name, dim, table_name, created_at, last_used_at
           FROM vector_models
          WHERE model_id = ? AND dim = ?`,
      )
      .get(identity.modelId, identity.dim) as VectorModelRow | undefined;

    if (!row) {
      throw new Error(
        `sqlite-vec: failed to find or create vector_models entry for ${identity.modelId}`,
      );
    }

    // Defensive: if a legacy row still carries a placeholder (e.g. the
    // database was created by an older version of this module), repair it.
    if (!row.table_name || row.table_name === "__pending__") {
      const tname = physicalTableName(row.id);
      sqlite
        .prepare(`UPDATE vector_models SET table_name = ? WHERE id = ?`)
        .run(tname, row.id);
      row.table_name = tname;
    }

    const target = rowToTarget(row);
    modelCache.set(target.modelRegistryId, target);
    ensurePhysicalTable(target);

    return target;
  }

  async function lockSessionEmbeddingModel(
    sessionId: string,
    target: VectorTarget,
  ): Promise<void> {
    // Check if already locked.
    const existing = sqlite
      .prepare(
        `SELECT embedding_model_id, embedding_locked_at FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionEmbeddingRow | undefined;

    if (!existing) {
      throw new Error(
        `sqlite-vec lockSessionEmbeddingModel: session ${sessionId} not found`,
      );
    }
    if (
      existing.embedding_model_id !== null &&
      existing.embedding_model_id !== undefined
    ) {
      throw new Error(
        `sqlite-vec lockSessionEmbeddingModel: session ${sessionId} is already locked to model ${existing.embedding_model_id}`,
      );
    }

    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE sessions
            SET embedding_model_id = ?, embedding_locked_at = ?
          WHERE id = ?`,
      )
      .run(target.modelRegistryId, now, sessionId);

    // Invalidate session cache so the next resolve hits DB.
    sessionTargetCache.delete(sessionId);
  }

  async function resolveSessionVectorTarget(
    sessionId: string,
  ): Promise<VectorTarget | null> {
    if (sessionTargetCache.has(sessionId)) {
      return sessionTargetCache.get(sessionId) ?? null;
    }

    const sessionRow = sqlite
      .prepare(
        `SELECT embedding_model_id, embedding_locked_at FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionEmbeddingRow | undefined;

    if (!sessionRow || sessionRow.embedding_model_id == null) {
      sessionTargetCache.set(sessionId, null);
      return null;
    }

    const modelId = sessionRow.embedding_model_id;

    // Try in-memory model cache first.
    const cached = modelCache.get(modelId);
    if (cached) {
      sessionTargetCache.set(sessionId, cached);
      return cached;
    }

    const modelRow = sqlite
      .prepare(
        `SELECT id, model_id, provider, model_name, dim, table_name, created_at, last_used_at
           FROM vector_models
          WHERE id = ?`,
      )
      .get(modelId) as VectorModelRow | undefined;

    if (!modelRow) {
      throw new Error(
        `sqlite-vec: session ${sessionId} references unknown vector_models.id ${modelId}`,
      );
    }

    const target = rowToTarget(modelRow);
    modelCache.set(target.modelRegistryId, target);
    sessionTargetCache.set(sessionId, target);
    ensurePhysicalTable(target);
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
    const rows = sqlite
      .prepare(
        `SELECT id, model_id, provider, model_name, dim, table_name, created_at, last_used_at
           FROM vector_models
          ORDER BY id`,
      )
      .all() as VectorModelRow[];

    return rows.map((r) => ({
      id: r.id,
      modelId: r.model_id,
      provider: r.provider,
      modelName: r.model_name,
      dim: r.dim,
      tableName: r.table_name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  // ── VectorStoreCapability ────────────────────────────────────────

  async function upsertVector(input: UpsertVectorInput): Promise<void> {
    const target = await resolveSessionVectorTarget(input.sessionId);
    if (!target) {
      throw new Error(
        `sqlite-vec upsertVector: session ${input.sessionId} has no embedding model locked`,
      );
    }
    if (input.embedding.length !== target.dim) {
      throw new Error(
        `sqlite-vec upsertVector: embedding length ${input.embedding.length} does not match model dim ${target.dim}`,
      );
    }

    ensurePhysicalTable(target);
    const tname = physicalTableName(target.modelRegistryId);

    // vec0 has no native primary key on user columns. Emulate upsert via
    // DELETE-then-INSERT in a transaction.
    const del = sqlite.prepare(
      `DELETE FROM ${tname}
        WHERE session_id = ? AND plugin_id = ? AND namespace = ? AND data_key = ?`,
    );
    const ins = sqlite.prepare(
      `INSERT INTO ${tname}
         (session_id, plugin_id, namespace, data_key, payload, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const txn = sqlite.transaction(() => {
      del.run(input.sessionId, input.pluginId, input.namespace, input.key);
      ins.run(
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
        input.payload ?? null,
        toJsonVector(input.embedding),
      );
    });
    txn();
  }

  async function searchVectors(
    input: SearchVectorsInput,
  ): Promise<VectorSearchResult[]> {
    const target = await resolveSessionVectorTarget(input.sessionId);
    if (!target) {
      // No embedding model locked → return empty results (RAG disabled).
      return [];
    }

    if (input.query.length !== target.dim) {
      throw new Error(
        `sqlite-vec searchVectors: query length ${input.query.length} does not match model dim ${target.dim}`,
      );
    }

    ensurePhysicalTable(target);
    const tname = physicalTableName(target.modelRegistryId);
    const topK = input.topK ?? 8;

    // Build WHERE dynamically. `k` must appear in WHERE for sqlite-vec.
    const conditions = ["embedding MATCH ?", "k = ?", "session_id = ?"];
    const params: Array<string | number> = [
      toJsonVector(input.query),
      Math.max(1, topK),
      input.sessionId,
    ];

    if (input.pluginId !== undefined) {
      conditions.push("plugin_id = ?");
      params.push(input.pluginId);
    }
    if (input.namespace !== undefined) {
      conditions.push("namespace = ?");
      params.push(input.namespace);
    }

    const sql = `
      SELECT session_id, plugin_id, namespace, data_key, payload, distance
        FROM ${tname}
       WHERE ${conditions.join(" AND ")}
       ORDER BY distance
    `;
    const rows = sqlite.prepare(sql).all(...params) as Array<{
      session_id: string;
      plugin_id: string;
      namespace: string;
      data_key: string;
      payload: string | null;
      distance: number;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      pluginId: r.plugin_id,
      namespace: r.namespace,
      key: r.data_key,
      distance: r.distance,
      payload: r.payload,
    }));
  }

  async function deleteVectors(input: DeleteVectorsInput): Promise<void> {
    const target = await resolveSessionVectorTarget(input.sessionId);
    if (!target) {
      // No embedding model — nothing to delete.
      return;
    }

    ensurePhysicalTable(target);
    const tname = physicalTableName(target.modelRegistryId);

    if (input.namespace !== undefined) {
      sqlite
        .prepare(
          `DELETE FROM ${tname}
            WHERE session_id = ? AND plugin_id = ? AND namespace = ?`,
        )
        .run(input.sessionId, input.pluginId, input.namespace);
    } else {
      sqlite
        .prepare(
          `DELETE FROM ${tname}
            WHERE session_id = ? AND plugin_id = ?`,
        )
        .run(input.sessionId, input.pluginId);
    }
  }

  return {
    upsertVector,
    searchVectors,
    deleteVectors,
    ensureVectorModel,
    lockSessionEmbeddingModel,
    resolveSessionVectorTarget,
    listVectorModels,
  };
}
