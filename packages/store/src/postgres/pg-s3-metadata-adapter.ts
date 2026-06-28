/**
 * PostgreSQL-backed durable metadata adapter for `createS3MediaStore`.
 *
 * The S3 client owns the bytes; this adapter persists everything else (mime /
 * size / owner / refs / meta / createdAt) in the shared `media_assets` /
 * `media_refs` PG tables — so S3-backed media survives restarts AND can be
 * shared across multiple server nodes (the SQLite adapter only covers a single
 * node). It mirrors `createSqliteS3MetadataAdapter` 1:1, reusing the same
 * adapter SQL as `createPgMediaStoreFromClient` minus the BYTEA `body` column
 * (the bytes live in S3, not the row).
 *
 * Metadata-only: `MediaStore.delete()` removes the S3 object before calling
 * `adapter.deleteAsset(id)`, so deletes here never touch bytes.
 */
import postgres, { type JSONValue, type Sql } from "postgres";
import { CREATE_MEDIA_TABLES_SQL } from "./pg-store-mappers.js";
import type {
  MediaAssetRecord,
  MediaRefRecord,
  S3MediaMetadataAdapter,
} from "../media-store.js";

export interface PgS3MetadataAdapterOptions {
  /** Drop + recreate the media tables on construction (tests / clean boot). */
  readonly freshSchema?: boolean;
}

interface AssetRow {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly meta: Record<string, unknown> | null;
  readonly owner_session_id: string | null;
  readonly owner_plugin_id: string | null;
  readonly created_at: string;
}

function rowToRecord(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    ownerSessionId: row.owner_session_id,
    ownerPluginId: row.owner_plugin_id,
    createdAt: row.created_at,
    ...(row.meta == null ? {} : { meta: row.meta }),
  };
}

/**
 * Create a PG-backed S3 metadata adapter from a connection string. Boots the
 * shared media DDL standalone (same as `createPgMediaStore`).
 */
export async function createPgS3MetadataAdapter(
  databaseUrl: string,
  options?: PgS3MetadataAdapterOptions,
): Promise<S3MediaMetadataAdapter> {
  const sql = postgres(databaseUrl);
  if (options?.freshSchema) {
    await sql`DROP TABLE IF EXISTS media_refs CASCADE`;
    await sql`DROP TABLE IF EXISTS media_assets CASCADE`;
  }
  await sql.unsafe(CREATE_MEDIA_TABLES_SQL);
  return createPgS3MetadataAdapterFromClient(sql);
}

/**
 * Build the adapter from an existing `postgres` client (lets a host share one
 * pool / wire a custom connection). Assumes the media tables already exist.
 */
export function createPgS3MetadataAdapterFromClient(
  sql: Sql,
): S3MediaMetadataAdapter {
  return {
    async upsertAsset(record) {
      // No BYTEA body (S3 owns the bytes); `path` carries a synthetic marker so
      // the row is self-describing, mirroring the SQLite adapter.
      await sql`
        INSERT INTO media_assets (id, sha256, mime, size, path, meta, owner_session_id, owner_plugin_id, created_at)
        VALUES (
          ${record.id},
          ${record.id},
          ${record.mime},
          ${record.size},
          ${`s3://${record.id}`},
          ${record.meta === undefined ? null : sql.json(record.meta as JSONValue)},
          ${record.ownerSessionId ?? null},
          ${record.ownerPluginId ?? null},
          ${record.createdAt}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    },

    async getAsset(id) {
      const rows = await sql<AssetRow[]>`
        SELECT id, mime, size, meta, owner_session_id, owner_plugin_id, created_at
        FROM media_assets
        WHERE id = ${id}
        LIMIT 1
      `;
      return rows[0] ? rowToRecord(rows[0]) : null;
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      await sql`
        UPDATE media_assets
        SET owner_session_id = ${ownerSessionId}, owner_plugin_id = ${ownerPluginId ?? null}
        WHERE id = ${id}
          AND (owner_session_id IS NULL OR owner_session_id = ${ownerSessionId})
      `;
    },

    async addRef(id, sessionId, pluginId) {
      // UNIQUE is (session_id, media_id) only — first writer keeps plugin_id.
      await sql`
        INSERT INTO media_refs (session_id, media_id, plugin_id, created_at)
        SELECT ${sessionId}, ${id}, ${pluginId ?? null}, ${new Date().toISOString()}
        WHERE EXISTS (SELECT 1 FROM media_assets WHERE id = ${id})
        ON CONFLICT (session_id, media_id) DO NOTHING
      `;
    },

    async removeRef(id, sessionId) {
      await sql`
        DELETE FROM media_refs
        WHERE media_id = ${id}
          AND session_id = ${sessionId}
      `;
    },

    async isReferencedBy(id, sessionId) {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM media_assets
        WHERE id = ${id}
          AND (
            owner_session_id = ${sessionId}
            OR EXISTS (
              SELECT 1
              FROM media_refs
              WHERE media_refs.media_id = media_assets.id
                AND media_refs.session_id = ${sessionId}
              LIMIT 1
            )
          )
        LIMIT 1
      `;
      return rows.length > 0;
    },

    async listAssets() {
      const rows = await sql<AssetRow[]>`
        SELECT id, mime, size, meta, owner_session_id, owner_plugin_id, created_at
        FROM media_assets
        ORDER BY created_at ASC, id ASC
      `;
      return rows.map(rowToRecord);
    },

    async listRefs() {
      const rows = await sql<
        {
          media_id: string;
          session_id: string;
          plugin_id: string | null;
          created_at: string;
        }[]
      >`
        SELECT media_id, session_id, plugin_id, created_at
        FROM media_refs
        ORDER BY created_at ASC, session_id ASC, media_id ASC
      `;
      return rows.map((row) => ({
        mediaId: row.media_id,
        sessionId: row.session_id,
        pluginId: row.plugin_id,
        createdAt: row.created_at,
      })) satisfies MediaRefRecord[];
    },

    async deleteAsset(id) {
      // Refs first to keep the metadata invariant (no orphan refs).
      await sql.begin(async (tx) => {
        await tx`DELETE FROM media_refs WHERE media_id = ${id}`;
        await tx`DELETE FROM media_assets WHERE id = ${id}`;
      });
    },
  };
}
