/**
 * SQLite-backed durable metadata adapter for `createS3MediaStore`.
 *
 * The S3 client owns the bytes; this adapter persists the everything-else:
 * mime / size / owner / refs / createdAt. It reuses the same `media_assets` /
 * `media_refs` schema as `createSqliteMediaStore` so a single SQLite database
 * can store durable metadata for both local-fs media and S3-backed media
 * (the `path` column ends up unused for S3-only assets, which is acceptable
 * because the schema is shared verbatim and content-addressed ids never
 * collide between backends).
 *
 * NOTE: this adapter is intentionally read/write only — it does NOT touch
 * any bytes. `MediaStore.delete()` already removes the S3 object before
 * calling `adapter.deleteAsset(id)`, so deletes here are metadata-only.
 */
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
	MediaAssetRecord,
	MediaRefRecord,
	S3MediaMetadataAdapter,
} from "../media-store.js";
import { createTables } from "./sqlite-store-mappers.js";

/**
 * Create a SQLite-backed metadata adapter at `dbPath`. Reuses the standard
 * media_assets / media_refs DDL — the same database can host metadata for
 * `createSqliteMediaStore` and `createS3MediaStore` simultaneously without
 * conflict (content-addressed ids partition them naturally).
 */
export function createSqliteS3MetadataAdapter(
	dbPath: string,
): S3MediaMetadataAdapter {
	const dbDir = dirname(dbPath);
	if (dbDir && dbDir !== "." && dbDir !== ":memory:") {
		mkdirSync(dbDir, { recursive: true });
	}

	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	createTables(sqlite);

	// S3-backed assets don't carry a local file path, but the shared schema
	// requires `path TEXT NOT NULL`. Stamp a synthetic marker so the row is
	// valid and the source of truth (S3 object key) is reconstructible.
	const insertAsset = sqlite.prepare(`
    INSERT INTO media_assets (id, sha256, mime, size, path, meta, owner_session_id, owner_plugin_id, created_at)
    VALUES (@id, @sha256, @mime, @size, @path, @meta, @ownerSessionId, @ownerPluginId, @createdAt)
    ON CONFLICT(id) DO NOTHING
  `);
	const selectAsset = sqlite.prepare(`
    SELECT id, mime, size, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId, created_at AS createdAt
    FROM media_assets
    WHERE id = ?
  `);
	const selectAllAssets = sqlite.prepare(`
    SELECT id, mime, size, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId, created_at AS createdAt
    FROM media_assets
    ORDER BY created_at ASC, id ASC
  `);
	const selectAllRefs = sqlite.prepare(`
    SELECT media_id AS mediaId, session_id AS sessionId, plugin_id AS pluginId, created_at AS createdAt
    FROM media_refs
    ORDER BY created_at ASC, session_id ASC, media_id ASC
  `);
	const removeAsset = sqlite.prepare("DELETE FROM media_assets WHERE id = ?");
	const removeRefs = sqlite.prepare(
		"DELETE FROM media_refs WHERE media_id = ?",
	);
	const updateOwnership = sqlite.prepare(`
    UPDATE media_assets
    SET owner_session_id = @sessionId, owner_plugin_id = @pluginId
    WHERE id = @id
      AND (owner_session_id IS NULL OR owner_session_id = @sessionId)
  `);
	const insertRef = sqlite.prepare(`
    INSERT OR IGNORE INTO media_refs (session_id, media_id, plugin_id, created_at)
    VALUES (@sessionId, @mediaId, @pluginId, @createdAt)
  `);
	const checkOwner = sqlite.prepare(
		"SELECT owner_session_id AS ownerSessionId FROM media_assets WHERE id = ?",
	);
	const checkRef = sqlite.prepare(
		"SELECT 1 AS one FROM media_refs WHERE session_id = ? AND media_id = ? LIMIT 1",
	);

	function rowToRecord(row: {
		id: string;
		mime: string;
		size: number;
		meta: string | null;
		ownerSessionId: string | null;
		ownerPluginId: string | null;
		createdAt: string;
	}): MediaAssetRecord {
		return {
			id: row.id,
			mime: row.mime,
			size: row.size,
			ownerSessionId: row.ownerSessionId,
			ownerPluginId: row.ownerPluginId,
			createdAt: row.createdAt,
			...(row.meta
				? { meta: JSON.parse(row.meta) as Readonly<Record<string, unknown>> }
				: {}),
		};
	}

	return {
		async upsertAsset(record) {
			insertAsset.run({
				id: record.id,
				sha256: record.id,
				mime: record.mime,
				size: record.size,
				path: `s3://${record.id}`,
				meta: record.meta === undefined ? null : JSON.stringify(record.meta),
				ownerSessionId: record.ownerSessionId ?? null,
				ownerPluginId: record.ownerPluginId ?? null,
				createdAt: record.createdAt,
			});
		},

		async getAsset(id) {
			const row = selectAsset.get(id) as
				| Parameters<typeof rowToRecord>[0]
				| undefined;
			return row ? rowToRecord(row) : null;
		},

		async recordOwnership(id, ownerSessionId, ownerPluginId) {
			updateOwnership.run({
				id,
				sessionId: ownerSessionId,
				pluginId: ownerPluginId ?? null,
			});
		},

		async addRef(id, sessionId, pluginId) {
			// Mirrors createSqliteMediaStore: INSERT OR IGNORE on the
			// (session_id, media_id) unique index — first writer keeps plugin_id.
			insertRef.run({
				sessionId,
				mediaId: id,
				pluginId: pluginId ?? null,
				createdAt: new Date().toISOString(),
			});
		},

		async isReferencedBy(id, sessionId) {
			const ownerRow = checkOwner.get(id) as
				| { ownerSessionId: string | null }
				| undefined;
			if (ownerRow?.ownerSessionId === sessionId) return true;
			return checkRef.get(sessionId, id) !== undefined;
		},

		async listAssets() {
			const rows = selectAllAssets.all() as Array<
				Parameters<typeof rowToRecord>[0]
			>;
			return rows.map(rowToRecord);
		},

		async listRefs() {
			return selectAllRefs.all() as MediaRefRecord[];
		},

		async deleteAsset(id) {
			// Refs first to keep a foreign-key-style invariant even though the
			// schema has no explicit FK between the two tables.
			removeRefs.run(id);
			removeAsset.run(id);
		},
	};
}
