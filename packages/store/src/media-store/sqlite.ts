import type { MediaRef, MediaRefRecord, MediaStore } from "@covel/shared";
import {
  acquireSqliteConnection,
  getConnectionWriteGate,
  releaseSqliteConnection,
} from "../sqlite/shared-connection.js";
import { MEDIA_WRITE_METHODS } from "../store-write-methods.js";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createTables } from "../sqlite/sqlite-store-mappers.js";
import type { SqliteMediaStoreOptions } from "./types.js";
import {
  cleanupCandidates,
  filterAssetsByMetadata,
  mediaPath,
  sha256,
  toBytes,
  toMeta,
} from "./utils.js";

export function createSqliteMediaStore(
  dbPath: string,
  options?: SqliteMediaStoreOptions,
): MediaStore {
  const dbDir = dirname(dbPath);
  if (dbDir && dbDir !== "." && dbDir !== ":memory:") {
    mkdirSync(dbDir, { recursive: true });
  }

  // Reuse the DataStore's connection for this file. Two connections to one
  // covel.db deadlock when the mirror media store writes (e.g. session-import
  // materializing world portraits) while the main store holds a write
  // transaction. See sqlite/shared-connection.ts.
  const sqlite = acquireSqliteConnection(dbPath);
  createTables(sqlite);

  const mediaRoot = resolve(
    options?.mediaRoot ??
      join(dbDir === ":memory:" ? process.cwd() : dbDir, "media"),
  );
  mkdirSync(mediaRoot, { recursive: true });

  const insertAsset = sqlite.prepare(`
    INSERT INTO media_assets (id, sha256, mime, size, path, meta, created_at)
    VALUES (@id, @sha256, @mime, @size, @path, @meta, @createdAt)
    ON CONFLICT(id) DO NOTHING
  `);
  const select = sqlite.prepare(
    "SELECT id, mime, size, path, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId FROM media_assets WHERE id = ?",
  );
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
  const remove = sqlite.prepare("DELETE FROM media_assets WHERE id = ?");
  const removeRefs = sqlite.prepare(
    "DELETE FROM media_refs WHERE media_id = ?",
  );

  // First-writer wins guard: only set owner when row has no owner yet, or
  // when the caller already owns it (idempotent re-record). Prevents a
  // second session/plugin silently stealing ownership of an existing asset.
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
  const removeRef = sqlite.prepare(`
    DELETE FROM media_refs
    WHERE media_id = @mediaId
      AND session_id = @sessionId
  `);
  const checkOwner = sqlite.prepare(
    "SELECT owner_session_id AS ownerSessionId FROM media_assets WHERE id = ?",
  );
  const checkRef = sqlite.prepare(
    "SELECT 1 AS one FROM media_refs WHERE session_id = ? AND media_id = ? LIMIT 1",
  );

  const store: MediaStore = {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = select.get(id) as
        | { id: string; mime: string; size: number; meta: string | null }
        | undefined;
      if (existing) {
        return {
          id: existing.id,
          mime: existing.mime,
          size: existing.size,
          ...(existing.meta
            ? {
                meta: JSON.parse(existing.meta) as Readonly<
                  Record<string, unknown>
                >,
              }
            : {}),
        };
      }
      const path = mediaPath(mediaRoot, id);
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) {
        writeFileSync(path, bytes);
      }
      const ref: MediaRef = {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      insertAsset.run({
        id,
        sha256: id,
        mime,
        size: bytes.byteLength,
        path,
        meta: meta === undefined ? null : JSON.stringify(meta),
        createdAt: new Date().toISOString(),
      });
      return ref;
    },

    async get(ref) {
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(readFileSync(row.path));
    },

    async exists(id) {
      const row = select.get(id) as { path: string } | undefined;
      return row !== undefined && existsSync(row.path);
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      return pathToFileURL(row.path).toString();
    },

    async delete(id) {
      const row = select.get(id) as { path: string } | undefined;
      // Clean up the inbound refs first so a foreign-key-style invariant holds
      // even though the schema has no explicit FK between the two tables.
      removeRefs.run(id);
      remove.run(id);
      if (row?.path) {
        rmSync(row.path, { force: true });
      }
    },

    async lookup(id) {
      const row = select.get(id) as
        | {
            id: string;
            mime: string;
            size: number;
            ownerSessionId: string | null;
            ownerPluginId: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.ownerSessionId ?? null,
        ownerPluginId: row.ownerPluginId ?? null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      updateOwnership.run({
        id,
        sessionId: ownerSessionId,
        pluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      // UNIQUE key is (session_id, media_id) only — first writer wins for
      // plugin_id. A subsequent addRef with a different pluginId is a no-op
      // (INSERT OR IGNORE swallows the unique-violation).
      insertRef.run({
        sessionId,
        mediaId: id,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
    },

    async removeRef(id, sessionId) {
      removeRef.run({ mediaId: id, sessionId });
    },

    async isReferencedBy(id, sessionId) {
      const ownerRow = checkOwner.get(id) as
        { ownerSessionId: string | null } | undefined;
      if (ownerRow?.ownerSessionId === sessionId) return true;
      const refRow = checkRef.get(sessionId, id) as { one: number } | undefined;
      return refRow !== undefined;
    },

    async listAssets() {
      const rows = selectAllAssets.all() as Array<{
        id: string;
        mime: string;
        size: number;
        meta: string | null;
        ownerSessionId: string | null;
        ownerPluginId: string | null;
        createdAt: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        mime: row.mime,
        size: row.size,
        ownerSessionId: row.ownerSessionId ?? null,
        ownerPluginId: row.ownerPluginId ?? null,
        createdAt: row.createdAt,
        ...(row.meta
          ? { meta: JSON.parse(row.meta) as Readonly<Record<string, unknown>> }
          : {}),
      }));
    },

    async listRefs() {
      return selectAllRefs.all() as MediaRefRecord[];
    },

    async listByMetadata(sessionId, filter) {
      return filterAssetsByMetadata(await this.listAssets(), sessionId, filter);
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

    async openReadStream(ref) {
      const row = select.get(ref.id) as { path: string } | undefined;
      if (!row) throw new Error(`Media asset not found: ${ref.id}`);
      // Node 22+ exposes Readable.toWeb; Covel's engines field requires Node ≥ 22.
      const nodeStream = createReadStream(row.path);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },

    close() {
      releaseSqliteConnection(sqlite);
    },
  };

  // Same connection as the DataStore ⇒ same write gate. Without this a media
  // write issued while another caller's transaction is open joins that
  // transaction and is silently lost when it rolls back.
  // ponytail: `cleanup` queues once and its inner `this.delete` calls then run
  // inline, which is what we want — they belong to that one maintenance unit.
  return getConnectionWriteGate(sqlite).gateWrites(store, MEDIA_WRITE_METHODS);
}
