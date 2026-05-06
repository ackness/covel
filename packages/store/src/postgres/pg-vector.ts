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
 * The `vector_models` table, the `sessions.embedding_model_id` column,
 * and the `vector` extension itself are all created by `pg-store-mappers.ts`
 * during store initialization. This module ONLY creates per-model physical
 * tables on demand — it does not duplicate the registry or session-column
 * DDL, and it does not run `CREATE EXTENSION`.
 */

import type { Sql } from "postgres";

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
		throw new Error(`pg-vector: invalid model registry id ${id}`);
	}
}

function physicalTableName(id: number): string {
	assertValidId(id);
	return `vec_mem_m${id}`;
}

/** Serialize a Float32Array for pgvector: "[v1,v2,...,vn]" */
function toVectorString(v: Float32Array): string {
	return `[${Array.from(v).join(",")}]`;
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Build the vector capability. Always returns an implementation — pgvector
 * extension availability is assumed (handled by the caller's bootstrap step).
 */
export function createPgVectorCapability(
	client: Sql,
): VectorStoreCapability & VectorModelOps {
	// In-memory caches to avoid redundant DB lookups within a process.
	const modelCache = new Map<number, VectorTarget>();
	const sessionTargetCache = new Map<string, VectorTarget | null>();
	const createdTables = new Set<number>();

	// NOTE: vector_models table and sessions.embedding_model_id column are
	// owned by pg-store-mappers.ts. We do not duplicate that DDL here.
	//
	// The `vector` extension itself is enabled lazily on first vector op so
	// that stores which never touch RAG (test fixtures, vector-disabled
	// deployments) can boot against plain postgres without superuser
	// privileges. ADR-002 still requires pgvector for any production PG
	// deployment that uses RAG plugins — it just fails at first call
	// instead of at boot.
	let extensionReady = false;
	async function ensureVectorExtension(): Promise<void> {
		if (extensionReady) return;
		await client.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
		extensionReady = true;
	}

	// ── Physical table management ────────────────────────────────────

	async function ensurePhysicalTable(target: VectorTarget): Promise<void> {
		if (createdTables.has(target.modelRegistryId)) return;
		await ensureVectorExtension();
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
      CREATE INDEX IF NOT EXISTS idx_${tname}_hnsw
        ON ${tname} USING hnsw (embedding vector_l2_ops)
        WITH (m = 16, ef_construction = 64);
      CREATE INDEX IF NOT EXISTS idx_${tname}_session
        ON ${tname} (session_id, plugin_id, namespace);
    `);

		createdTables.add(target.modelRegistryId);
	}

	// ── VectorModelOps ───────────────────────────────────────────────

	async function ensureVectorModel(
		identity: EmbeddingModelIdentity,
	): Promise<VectorTarget> {
		const now = Date.now();

		// INSERT ON CONFLICT DO NOTHING — table_name is left to its DEFAULT
		// ''; the schema-side BEFORE INSERT trigger backfills it from NEW.id
		// before the row hits the table. UNIQUE(model_id, dim) makes
		// concurrent inserts safe.
		await client`
      INSERT INTO vector_models (model_id, provider, model_name, dim, created_at)
      VALUES (${identity.modelId}, ${identity.provider}, ${identity.modelName}, ${identity.dim}, ${now})
      ON CONFLICT (model_id, dim) DO NOTHING
    `;

		// Read back the canonical row. By the time we get here the trigger
		// has populated table_name.
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
       WHERE model_id = ${identity.modelId} AND dim = ${identity.dim}
    `;

		if (rows.length === 0) {
			throw new Error(
				`pg-vector: failed to find or create vector_models entry for ${identity.modelId}`,
			);
		}

		const row = rows[0];

		// Defensive: repair legacy rows from older module versions that used
		// the old "__pending__" placeholder scheme.
		if (!row.table_name || row.table_name === "__pending__") {
			const tname = physicalTableName(row.id);
			await client`
        UPDATE vector_models SET table_name = ${tname} WHERE id = ${row.id}
      `;
			row.table_name = tname;
		}

		const target: VectorTarget = {
			modelRegistryId: row.id,
			modelId: row.model_id,
			dim: row.dim,
			tableName: row.table_name,
		};

		modelCache.set(target.modelRegistryId, target);
		await ensurePhysicalTable(target);

		return target;
	}

	async function lockSessionEmbeddingModel(
		sessionId: string,
		target: VectorTarget,
	): Promise<void> {
		const rows = await client<
			Array<{
				embedding_model_id: number | null;
				embedding_locked_at: string | null;
			}>
		>`
      SELECT embedding_model_id, embedding_locked_at
        FROM sessions
       WHERE id = ${sessionId}
    `;

		if (rows.length === 0) {
			throw new Error(
				`pg-vector lockSessionEmbeddingModel: session ${sessionId} not found`,
			);
		}

		const existing = rows[0];
		if (
			existing.embedding_model_id !== null &&
			existing.embedding_model_id !== undefined
		) {
			throw new Error(
				`pg-vector lockSessionEmbeddingModel: session ${sessionId} is already locked to model ${existing.embedding_model_id}`,
			);
		}

		const now = new Date().toISOString();
		await client`
      UPDATE sessions
         SET embedding_model_id = ${target.modelRegistryId},
             embedding_locked_at = ${now}
       WHERE id = ${sessionId}
    `;

		// Invalidate session cache.
		sessionTargetCache.delete(sessionId);
	}

	async function resolveSessionVectorTarget(
		sessionId: string,
	): Promise<VectorTarget | null> {
		if (sessionTargetCache.has(sessionId)) {
			return sessionTargetCache.get(sessionId) ?? null;
		}

		const sessionRows = await client<
			Array<{ embedding_model_id: number | null }>
		>`
      SELECT embedding_model_id FROM sessions WHERE id = ${sessionId}
    `;

		if (sessionRows.length === 0 || sessionRows[0].embedding_model_id == null) {
			sessionTargetCache.set(sessionId, null);
			return null;
		}

		const modelId = sessionRows[0].embedding_model_id;

		// Try in-memory model cache first.
		const cached = modelCache.get(modelId);
		if (cached) {
			sessionTargetCache.set(sessionId, cached);
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
			tableName: row.table_name,
		};

		modelCache.set(target.modelRegistryId, target);
		sessionTargetCache.set(sessionId, target);
		await ensurePhysicalTable(target);

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
			tableName: r.table_name,
			createdAt: Number(r.created_at),
			lastUsedAt: r.last_used_at !== null ? Number(r.last_used_at) : null,
		}));
	}

	// ── VectorStoreCapability ────────────────────────────────────────

	async function upsertVector(input: UpsertVectorInput): Promise<void> {
		const target = await resolveSessionVectorTarget(input.sessionId);
		if (!target) {
			throw new Error(
				`pg-vector upsertVector: session ${input.sessionId} has no embedding model locked`,
			);
		}
		if (input.embedding.length !== target.dim) {
			throw new Error(
				`pg-vector upsertVector: embedding length ${input.embedding.length} does not match model dim ${target.dim}`,
			);
		}

		await ensurePhysicalTable(target);
		const tname = physicalTableName(target.modelRegistryId);
		const vecStr = toVectorString(input.embedding);

		await client.unsafe(
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

		await ensurePhysicalTable(target);
		const tname = physicalTableName(target.modelRegistryId);
		const topK = input.topK ?? 8;
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
			`SELECT session_id, plugin_id, namespace, key, payload,
              embedding <-> $1::vector AS distance
         FROM ${tname}
        WHERE ${whereSql}
        ORDER BY distance
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

	async function deleteVectors(input: DeleteVectorsInput): Promise<void> {
		const target = await resolveSessionVectorTarget(input.sessionId);
		if (!target) {
			// No embedding model — nothing to delete.
			return;
		}

		await ensurePhysicalTable(target);
		const tname = physicalTableName(target.modelRegistryId);

		if (input.namespace !== undefined) {
			await client.unsafe(
				`DELETE FROM ${tname}
          WHERE session_id = $1 AND plugin_id = $2 AND namespace = $3`,
				[input.sessionId, input.pluginId, input.namespace],
			);
		} else {
			await client.unsafe(
				`DELETE FROM ${tname}
          WHERE session_id = $1 AND plugin_id = $2`,
				[input.sessionId, input.pluginId],
			);
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
