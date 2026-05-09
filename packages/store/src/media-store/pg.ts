import type { MediaStore } from "@covel/shared";
import postgres, { type JSONValue, type Sql } from "postgres";
import { CREATE_MEDIA_TABLES_SQL } from "../postgres/pg-store-mappers.js";
import type { PgMediaStoreOptions } from "./types.js";
import {
  cleanupCandidates,
  normalizeBytes,
  sha256,
  toBytes,
  toMeta,
} from "./utils.js";

export async function createPgMediaStore(
  databaseUrl: string,
  options?: PgMediaStoreOptions,
): Promise<MediaStore> {
  const sql = postgres(databaseUrl);

  if (options?.freshSchema) {
    await sql`DROP TABLE IF EXISTS media_refs CASCADE`;
    await sql`DROP TABLE IF EXISTS media_assets CASCADE`;
  }
  await sql.unsafe(CREATE_MEDIA_TABLES_SQL);

  return createPgMediaStoreFromClient(sql);
}

export function createPgMediaStoreFromClient(sql: Sql): MediaStore {
  async function select(id: string): Promise<{
    id: string;
    mime: string;
    size: number;
    meta: Record<string, unknown> | null;
    body: Buffer | Uint8Array | null;
    owner_session_id: string | null;
    owner_plugin_id: string | null;
  } | null> {
    const rows = await sql<
      {
        id: string;
        mime: string;
        size: number;
        meta: Record<string, unknown> | null;
        body: Buffer | Uint8Array | null;
        owner_session_id: string | null;
        owner_plugin_id: string | null;
      }[]
    >`
      SELECT id, mime, size, meta, body, owner_session_id, owner_plugin_id
      FROM media_assets
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = await select(id);
      if (existing) {
        return {
          id: existing.id,
          mime: existing.mime,
          size: existing.size,
          ...(existing.meta == null ? {} : { meta: existing.meta }),
        };
      }

      await sql`
        INSERT INTO media_assets (id, sha256, mime, size, body, meta, created_at)
        VALUES (
          ${id},
          ${id},
          ${mime},
          ${bytes.byteLength},
          ${Buffer.from(bytes)},
          ${meta === undefined ? null : sql.json(meta as JSONValue)},
          ${new Date().toISOString()}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      const inserted = await select(id);
      if (inserted) {
        return {
          id: inserted.id,
          mime: inserted.mime,
          size: inserted.size,
          ...(inserted.meta == null ? {} : { meta: inserted.meta }),
        };
      }

      return {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
    },

    async get(ref) {
      const row = await select(ref.id);
      if (!row?.body) throw new Error(`Media asset not found: ${ref.id}`);
      return normalizeBytes(row.body);
    },

    async exists(id) {
      const row = await select(id);
      return row?.body != null;
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const row = await select(ref.id);
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return `pg://media/${ref.id}`;
    },

    async delete(id) {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM media_refs WHERE media_id = ${id}`;
        await tx`DELETE FROM media_assets WHERE id = ${id}`;
      });
    },

    async lookup(id) {
      const row = await select(id);
      if (!row) return null;
      return {
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.owner_session_id,
        ownerPluginId: row.owner_plugin_id,
      };
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
      // UNIQUE key is (session_id, media_id) only — first writer wins for
      // plugin_id. A subsequent addRef with a different pluginId is a no-op.
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
      const rows = await sql<
        {
          id: string;
          mime: string;
          size: number;
          meta: Record<string, unknown> | null;
          owner_session_id: string | null;
          owner_plugin_id: string | null;
          created_at: string;
        }[]
      >`
        SELECT id, mime, size, meta, owner_session_id, owner_plugin_id, created_at
        FROM media_assets
        ORDER BY created_at ASC, id ASC
      `;
      return rows.map((row) => ({
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.owner_session_id,
        ownerPluginId: row.owner_plugin_id,
        createdAt: row.created_at,
        ...(row.meta == null ? {} : { meta: row.meta }),
      }));
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
      }));
    },

    async cleanup(protectedIds, policy) {
      const { result, idsToDelete } = cleanupCandidates(
        await this.listAssets(),
        protectedIds,
        policy,
      );
      if (!policy?.dryRun) {
        for (const id of idsToDelete) {
          await this.delete(id);
        }
      }
      return result;
    },

    // openReadStream is intentionally NOT implemented for the PG bytea
    // backend. The previous version called `this.get(ref)`, which read the
    // entire BYTEA into memory before wrapping it in a one-shot
    // ReadableStream — so it failed the contract's stated goal ("> 1 MiB
    // assets stream to keep V8 ArrayBuffer pressure off the request path").
    // The route in apps/server/src/routes/api/media.ts already gates on
    // `typeof store.openReadStream === "function"`, so omitting it cleanly
    // falls back to the eager `get()` path. Operators with media > 1 MiB on
    // PostgreSQL should switch to SQLite-backed media (createSqliteMediaStore)
    // or S3 with a metadata adapter — see docs/reference/media-store.md.
  };
}
