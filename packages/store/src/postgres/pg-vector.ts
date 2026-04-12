/**
 * pgvector VectorStoreCapability implementation for PgStore.
 *
 * Phase 1 STATUS: skeleton / opt-in. This module is only wired when the
 * environment declares `PGVECTOR_ENABLED=1`. It assumes the `vector`
 * extension is already installed in the target database (the
 * `pgvector/pgvector` Docker image or `CREATE EXTENSION vector`).
 *
 * Schema
 * ------
 *
 * Unlike sqlite-vec we use a single table with a `dim int` column and
 * the standard HNSW index. pgvector supports variable-dimension `vector`
 * columns only when declared as `vector` (no fixed length), at the cost
 * of losing planner-known dimensions — for Phase 1 we accept that
 * tradeoff for simplicity.
 *
 *   CREATE TABLE plugin_vector_memory (
 *     id         text primary key,
 *     session_id text not null,
 *     plugin_id  text not null,
 *     namespace  text not null,
 *     data_key   text not null,
 *     dim        int  not null,
 *     embedding  vector not null,
 *     payload    text,
 *     created_at timestamptz not null default now(),
 *     unique (session_id, plugin_id, namespace, data_key)
 *   );
 *
 * Phase 2 will split by dimension, add HNSW indexes per dim, and wire
 * proper contract tests against a dockerized pgvector image.
 */

import type { Sql } from "postgres";

import type {
  VectorStoreCapability,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from "../vector-store.js";

const SKELETON_NOT_IMPLEMENTED =
  "pgvector VectorStoreCapability is a Phase 1 skeleton. Enable PGVECTOR_ENABLED, install the vector extension, and wait for Phase 2 implementation.";

/**
 * Build the capability. Currently returns a set of throwing stubs so the
 * type surface is complete and PgStore can be declared as supporting
 * vector search once Phase 2 lands.
 *
 * @param client — postgres.js Sql instance, reused from the PgStore factory
 */
export function createPgVectorCapability(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  client: Sql,
): VectorStoreCapability {
  async function upsertVector(_input: UpsertVectorInput): Promise<void> {
    throw new Error(SKELETON_NOT_IMPLEMENTED);
  }
  async function searchVectors(
    _input: SearchVectorsInput,
  ): Promise<VectorSearchResult[]> {
    throw new Error(SKELETON_NOT_IMPLEMENTED);
  }
  async function deleteVectors(_input: DeleteVectorsInput): Promise<void> {
    throw new Error(SKELETON_NOT_IMPLEMENTED);
  }
  return { upsertVector, searchVectors, deleteVectors };
}

/**
 * SQL snippets to seed a pgvector-backed deployment. Callers run these
 * out-of-band (e.g. Drizzle migration, or the T3 deployment script).
 * Kept here so Phase 2 can reference them from a real DDL runner.
 */
export const PGVECTOR_BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS plugin_vector_memory (
  id         text        PRIMARY KEY,
  session_id text        NOT NULL,
  plugin_id  text        NOT NULL,
  namespace  text        NOT NULL,
  data_key   text        NOT NULL,
  dim        int         NOT NULL,
  embedding  vector      NOT NULL,
  payload    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, plugin_id, namespace, data_key)
);

CREATE INDEX IF NOT EXISTS plugin_vector_memory_session_idx
  ON plugin_vector_memory (session_id, plugin_id, namespace);
`.trim();
