/**
 * sqlite-vec VectorStoreCapability implementation for SqliteStore.
 *
 * Design
 * ------
 *
 * - One `vec_memory_f{dim}` vec0 virtual table per embedding dimension.
 *   Dimensions are fixed at CREATE TABLE time in sqlite-vec, so we cannot
 *   commingle vectors of different dims in a single table. Tables are
 *   created lazily on the first upsert for a new dimension.
 *
 * - `session_id` is the partition key (text), `plugin_id`/`namespace`/
 *   `data_key` are metadata columns that support equality filtering, and
 *   `payload` is an auxiliary (+prefix) column — stored alongside the
 *   vector but not used in WHERE clauses.
 *
 * - Query shape: `WHERE embedding MATCH ? AND k = ? AND session_id = ?`
 *   with optional `AND plugin_id = ? AND namespace = ?`.
 *
 * - Uniqueness within a dimension table is enforced in application code
 *   via a DELETE-then-INSERT transaction keyed on
 *   `(session_id, plugin_id, namespace, data_key)`. sqlite-vec does not
 *   expose primary key semantics on vec0, so we emulate them here.
 *
 * - If sqlite-vec fails to load (unsupported platform, missing binary),
 *   `createSqliteVectorCapability` returns `null` and the store exposes
 *   no VectorStoreCapability methods. Callers must branch via
 *   `supportsVector()`.
 */

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type {
  VectorStoreCapability,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from "../vector-store.js";

/** Regex to validate a positive integer dimension before SQL interpolation. */
const DIM_PATTERN = /^[0-9]{1,6}$/;

function assertValidDim(dim: number): void {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 99_999) {
    throw new Error(`sqlite-vec: invalid dimension ${dim}`);
  }
  if (!DIM_PATTERN.test(String(dim))) {
    throw new Error(`sqlite-vec: dimension ${dim} failed safety check`);
  }
}

function tableName(dim: number): string {
  assertValidDim(dim);
  return `vec_memory_f${dim}`;
}

/** Convert a Float32Array to the JSON string form sqlite-vec expects. */
function toJsonVector(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}

/**
 * Build the capability. Returns null if sqlite-vec cannot be loaded on
 * the current platform — callers should treat vector support as
 * unavailable and fall back to structured retrieval.
 */
export function createSqliteVectorCapability(
  sqlite: Database.Database,
): VectorStoreCapability | null {
  try {
    sqliteVec.load(sqlite);
  } catch (err) {
    // Loading can fail on unsupported platforms or if the optional
    // dependency is pruned. We downgrade to null rather than crashing
    // the entire store.
    // eslint-disable-next-line no-console
    console.warn(
      `[sqlite-store] sqlite-vec unavailable — vector capability disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  /** Dimensions for which a vec0 virtual table already exists. */
  const knownDims = new Set<number>();

  function ensureTable(dim: number): void {
    if (knownDims.has(dim)) return;
    const name = tableName(dim);
    // Single statement: sqlite-vec creates the shadow tables internally.
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
        session_id  text partition key,
        plugin_id   text,
        namespace   text,
        data_key    text,
        +payload    text,
        embedding   float[${dim}]
      );
    `);
    knownDims.add(dim);
  }

  async function upsertVector(input: UpsertVectorInput): Promise<void> {
    if (input.embedding.length !== input.dimensions) {
      throw new Error(
        `sqlite-vec upsert: embedding length ${input.embedding.length} does not match declared dimensions ${input.dimensions}`,
      );
    }
    ensureTable(input.dimensions);
    const name = tableName(input.dimensions);

    // vec0 has no native primary key on user columns. Emulate upsert by
    // deleting any row matching the quadruple first, then inserting.
    const del = sqlite.prepare(`
      DELETE FROM ${name}
       WHERE session_id = ? AND plugin_id = ? AND namespace = ? AND data_key = ?
    `);
    const ins = sqlite.prepare(`
      INSERT INTO ${name}
        (session_id, plugin_id, namespace, data_key, payload, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const txn = sqlite.transaction(() => {
      del.run(
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
      );
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
    if (input.query.length !== input.dimensions) {
      throw new Error(
        `sqlite-vec search: query length ${input.query.length} does not match declared dimensions ${input.dimensions}`,
      );
    }
    // No table yet for this dimension → zero rows, zero results.
    if (!knownDims.has(input.dimensions)) {
      // Still attempt to query — IF NOT EXISTS means the table might exist
      // from a prior process. Create it idempotently so queries work.
      try {
        ensureTable(input.dimensions);
      } catch {
        return [];
      }
    }
    const name = tableName(input.dimensions);

    // Build WHERE dynamically. `k` must appear in WHERE for pre-v1
    // sqlite-vec; placing it in LIMIT only works on SQLite 3.41+.
    const conditions = [
      "embedding MATCH ?",
      "k = ?",
      "session_id = ?",
    ];
    const params: Array<string | number> = [
      toJsonVector(input.query),
      Math.max(0, input.topK),
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
        FROM ${name}
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
    const targetDims =
      input.dimensions !== undefined ? [input.dimensions] : Array.from(knownDims);
    for (const dim of targetDims) {
      if (!knownDims.has(dim)) continue;
      const name = tableName(dim);
      if (input.namespace !== undefined) {
        sqlite
          .prepare(
            `DELETE FROM ${name} WHERE session_id = ? AND plugin_id = ? AND namespace = ?`,
          )
          .run(input.sessionId, input.pluginId, input.namespace);
      } else {
        sqlite
          .prepare(
            `DELETE FROM ${name} WHERE session_id = ? AND plugin_id = ?`,
          )
          .run(input.sessionId, input.pluginId);
      }
    }
  }

  return { upsertVector, searchVectors, deleteVectors };
}
