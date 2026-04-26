import type { MediaRef } from '@covel/shared';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import postgres, { type JSONValue, type Sql } from 'postgres';
import { createTables } from './sqlite/sqlite-store-mappers.js';
import { CREATE_MEDIA_TABLES_SQL } from './postgres/pg-store-mappers.js';

/**
 * Lightweight ownership / metadata view returned by `MediaStore.lookup()`.
 *
 * Distinct from `MediaRef` because callers (e.g. the `/api/media/:id` route)
 * need the owner identifiers to perform per-session authorisation BEFORE
 * dereferencing the bytes. Owner fields are nullable: assets uploaded before
 * `recordOwnership()` runs (legacy, or runtime contexts that don't yet thread
 * a sessionId) will appear with `ownerSessionId: null`.
 */
export interface MediaAssetLookup {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly ownerSessionId: string | null;
  readonly ownerPluginId: string | null;
}

export interface MediaAssetRecord extends MediaAssetLookup {
  readonly createdAt: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface MediaRefRecord {
  readonly mediaId: string;
  readonly sessionId: string;
  readonly pluginId: string | null;
  readonly createdAt: string;
}

export interface MediaLifecyclePolicy {
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly keepRecentBytes?: number;
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface MediaCleanupResult {
  readonly scanned: number;
  readonly protected: number;
  readonly retained: number;
  readonly deleted: number;
  readonly totalBytes: number;
  readonly bytesDeleted: number;
  readonly bytesRetained: number;
  readonly protectedIds: readonly string[];
  readonly deletedIds: readonly string[];
}

export interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  /**
   * Returns owner / size metadata for an existing asset, or `null` if the id
   * is unknown. Used by route-level auth checks and by the runtime to decide
   * whether an asset already belongs to the current session before re-`put`-ing.
   */
  lookup(id: string): Promise<MediaAssetLookup | null>;
  /**
   * Idempotently mark an asset as owned by `(sessionId, pluginId?)`.
   *
   * First-writer wins: a second call with a different `sessionId` does NOT
   * overwrite an already-set owner. This matches the SQLite UPDATE guard
   * (`WHERE owner_session_id IS NULL OR owner_session_id = ?`) and prevents
   * a malicious or buggy plugin from re-owning another session's asset.
   */
  recordOwnership(id: string, ownerSessionId: string, ownerPluginId?: string): Promise<void>;
  /**
   * Idempotently record that `sessionId` references this asset (used by fork /
   * inherit flows where multiple sessions need read access without taking
   * ownership). The unique index on `(session_id, media_id)` makes repeated
   * calls a no-op; `pluginId` is recorded as first-source metadata only and
   * does NOT participate in the key (a second addRef with a different
   * pluginId is a silent no-op, preserving the first writer's pluginId).
   */
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  /**
   * True if `sessionId` owns the asset OR has a row in `media_refs` for it.
   * The route handler uses this to gate dereferencing.
   */
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  /** List stored assets for GC/quota/retention policy decisions. */
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  /** List explicit cross-session refs for fork/snapshot protection. */
  listRefs(): Promise<readonly MediaRefRecord[]>;
  /**
   * Delete unprotected assets according to age/quota policy. Callers provide
   * protected ids after scanning live sessions, snapshots, and refs.
   */
  cleanup(
    protectedIds: ReadonlySet<string>,
    policy?: MediaLifecyclePolicy,
  ): Promise<MediaCleanupResult>;
  /**
   * Optional streaming read for large assets. Callers SHOULD fall back to
   * `get()` when this is undefined (e.g. tests with hand-rolled mocks).
   */
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
}

export interface SqliteMediaStoreOptions {
  readonly mediaRoot?: string;
}

export interface PgMediaStoreOptions {
  readonly freshSchema?: boolean;
}

export interface S3CompatibleObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface S3CompatibleObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly mime: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface S3CompatibleMediaClient {
  putObject(input: S3CompatibleObject): Promise<void>;
  getObject(key: string): Promise<S3CompatibleObject | null>;
  headObject(key: string): Promise<S3CompatibleObjectInfo | null>;
  deleteObject(key: string): Promise<void>;
  createSignedGetUrl?(key: string): Promise<string>;
}

export interface S3MediaStoreOptions {
  readonly bucket?: string;
  readonly keyPrefix?: string;
  readonly publicBaseUrl?: string;
}

interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly ref: MediaRef;
  readonly createdAt: string;
}

interface OwnerRecord {
  readonly sessionId: string;
  readonly pluginId: string | null;
}

function cleanupCandidates(
  assets: readonly MediaAssetRecord[],
  protectedIds: ReadonlySet<string>,
  policy: MediaLifecyclePolicy = {},
): {
  readonly result: MediaCleanupResult;
  readonly idsToDelete: readonly string[];
} {
  const nowMs = policy.now?.getTime() ?? Date.now();
  const protectedSet = new Set(protectedIds);
  const sorted = [...assets].sort((a, b) => {
    const byCreated = a.createdAt.localeCompare(b.createdAt);
    return byCreated === 0 ? a.id.localeCompare(b.id) : byCreated;
  });
  const idsToDelete = new Set<string>();
  let currentBytes = sorted.reduce((sum, asset) => sum + asset.size, 0);

  if (typeof policy.maxAgeMs === 'number' && policy.maxAgeMs >= 0) {
    const cutoff = nowMs - policy.maxAgeMs;
    for (const asset of sorted) {
      if (protectedSet.has(asset.id)) continue;
      const created = Date.parse(asset.createdAt);
      if (Number.isFinite(created) && created <= cutoff) {
        idsToDelete.add(asset.id);
        currentBytes -= asset.size;
      }
    }
  }

  if (typeof policy.keepRecentBytes === 'number' && policy.keepRecentBytes >= 0) {
    let recentBytes = 0;
    for (const asset of [...sorted].reverse()) {
      if (protectedSet.has(asset.id) || idsToDelete.has(asset.id)) continue;
      recentBytes += asset.size;
      if (recentBytes > policy.keepRecentBytes) {
        idsToDelete.add(asset.id);
        currentBytes -= asset.size;
      }
    }
  }

  if (typeof policy.maxBytes === 'number' && policy.maxBytes >= 0) {
    for (const asset of sorted) {
      if (currentBytes <= policy.maxBytes) break;
      if (protectedSet.has(asset.id) || idsToDelete.has(asset.id)) continue;
      idsToDelete.add(asset.id);
      currentBytes -= asset.size;
    }
  }

  const deletedIds = [...idsToDelete];
  const deletedSet = new Set(deletedIds);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  const bytesDeleted = assets
    .filter((asset) => deletedSet.has(asset.id))
    .reduce((sum, asset) => sum + asset.size, 0);

  return {
    idsToDelete: deletedIds,
    result: {
      scanned: assets.length,
      protected: assets.filter((asset) => protectedSet.has(asset.id)).length,
      retained: assets.length - deletedIds.length,
      deleted: deletedIds.length,
      totalBytes,
      bytesDeleted,
      bytesRetained: totalBytes - bytesDeleted,
      protectedIds: [...protectedSet].sort(),
      deletedIds,
    },
  };
}

async function toBytes(blob: Uint8Array | Blob): Promise<Uint8Array> {
  if (blob instanceof Uint8Array) return new Uint8Array(blob);
  return new Uint8Array(await blob.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mediaPath(root: string, id: string): string {
  return join(root, id.slice(0, 2), id.slice(2, 4), `${id}.bin`);
}

function toMeta(meta?: object): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined ? undefined : { ...(meta as Record<string, unknown>) };
}

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Copy to a fresh Uint8Array so the stream owner can't observe later mutations
  // of the source buffer.
  const copy = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

function mediaObjectKey(id: string, prefix?: string): string {
  const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.bin`;
  if (!prefix) return key;
  return `${prefix.replace(/\/+$/, '')}/${key}`;
}

function normalizeBytes(value: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export function createMemoryMediaStore(): MediaStore {
  const assets = new Map<string, StoredMedia>();
  const owners = new Map<string, OwnerRecord>();
  // Inverted index: sessionId → set of media ids referenced. Mirrors the
  // SQLite media_refs table so isReferencedBy() can stay O(1).
  const refs = new Map<string, Set<string>>();
  const refRows = new Map<string, MediaRefRecord>();

  function addRefInternal(sessionId: string, id: string): void {
    let set = refs.get(sessionId);
    if (!set) {
      set = new Set<string>();
      refs.set(sessionId, set);
    }
    set.add(id);
  }

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = assets.get(id);
      if (existing) return existing.ref;
      const ref: MediaRef = {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      assets.set(id, { bytes: new Uint8Array(bytes), ref, createdAt: new Date().toISOString() });
      return ref;
    },

    async get(ref) {
      const asset = assets.get(ref.id);
      if (!asset) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(asset.bytes);
    },

    async exists(id) {
      return assets.has(id);
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      if (!assets.has(ref.id)) throw new Error(`Media asset not found: ${ref.id}`);
      return `memory://media/${ref.id}`;
    },

    async delete(id) {
      assets.delete(id);
      owners.delete(id);
      // Drop reverse refs so isReferencedBy stays consistent across delete/recreate.
      for (const set of refs.values()) {
        set.delete(id);
      }
      for (const [key, row] of refRows) {
        if (row.mediaId === id) refRows.delete(key);
      }
    },

    async lookup(id) {
      const asset = assets.get(id);
      if (!asset) return null;
      const owner = owners.get(id);
      return {
        id,
        mime: asset.ref.mime,
        size: asset.ref.size,
        ownerSessionId: owner?.sessionId ?? null,
        ownerPluginId: owner?.pluginId ?? null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      if (!assets.has(id)) return;
      const existing = owners.get(id);
      if (existing && existing.sessionId !== ownerSessionId) {
        // First-writer wins: do not overwrite a different session's ownership.
        return;
      }
      owners.set(id, {
        sessionId: ownerSessionId,
        pluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      if (!assets.has(id)) return;
      addRefInternal(sessionId, id);
      // First writer wins for plugin_id — keyed only on (sessionId, mediaId)
      // to mirror the UNIQUE constraint enforced by SQLite/PG.
      const key = `${sessionId}\u0000${id}`;
      if (!refRows.has(key)) {
        refRows.set(key, {
          sessionId,
          mediaId: id,
          pluginId: pluginId ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    },

    async isReferencedBy(id, sessionId) {
      const owner = owners.get(id);
      if (owner?.sessionId === sessionId) return true;
      return refs.get(sessionId)?.has(id) ?? false;
    },

    async listAssets() {
      return [...assets.values()].map((asset) => {
        const owner = owners.get(asset.ref.id);
        return {
          id: asset.ref.id,
          mime: asset.ref.mime,
          size: asset.ref.size,
          ownerSessionId: owner?.sessionId ?? null,
          ownerPluginId: owner?.pluginId ?? null,
          createdAt: asset.createdAt,
          ...(asset.ref.meta === undefined ? {} : { meta: asset.ref.meta }),
        };
      });
    },

    async listRefs() {
      return [...refRows.values()];
    },

    async cleanup(protectedIds, policy) {
      const { result, idsToDelete } = cleanupCandidates(await this.listAssets(), protectedIds, policy);
      if (!policy?.dryRun) {
        for (const id of idsToDelete) {
          await this.delete(id);
        }
      }
      return result;
    },

    async openReadStream(ref) {
      const asset = assets.get(ref.id);
      if (!asset) throw new Error(`Media asset not found: ${ref.id}`);
      return bytesToReadableStream(asset.bytes);
    },
  };
}

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
    const rows = await sql<{
      id: string;
      mime: string;
      size: number;
      meta: Record<string, unknown> | null;
      body: Buffer | Uint8Array | null;
      owner_session_id: string | null;
      owner_plugin_id: string | null;
    }[]>`
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
      const rows = await sql<{
        id: string;
        mime: string;
        size: number;
        meta: Record<string, unknown> | null;
        owner_session_id: string | null;
        owner_plugin_id: string | null;
        created_at: string;
      }[]>`
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
      const rows = await sql<{
        media_id: string;
        session_id: string;
        plugin_id: string | null;
        created_at: string;
      }[]>`
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
      const { result, idsToDelete } = cleanupCandidates(await this.listAssets(), protectedIds, policy);
      if (!policy?.dryRun) {
        for (const id of idsToDelete) {
          await this.delete(id);
        }
      }
      return result;
    },

    async openReadStream(ref) {
      const bytes = await this.get(ref);
      return bytesToReadableStream(await toBytes(bytes));
    },
  };
}

export function createS3MediaStore(
  client: S3CompatibleMediaClient,
  options?: S3MediaStoreOptions,
): MediaStore {
  const owners = new Map<string, OwnerRecord>();
  const refs = new Map<string, Set<string>>();
  const metaById = new Map<string, MediaRef>();
  const createdAtById = new Map<string, string>();
  const refRows = new Map<string, MediaRefRecord>();

  function addRefInternal(sessionId: string, id: string): void {
    let set = refs.get(sessionId);
    if (!set) {
      set = new Set<string>();
      refs.set(sessionId, set);
    }
    set.add(id);
  }

  function makeUrl(ref: MediaRef): string {
    if (options?.publicBaseUrl) {
      return `${options.publicBaseUrl.replace(/\/+$/, '')}/${mediaObjectKey(ref.id, options.keyPrefix)}`;
    }
    const bucket = options?.bucket ?? 'media';
    return `s3://${bucket}/${mediaObjectKey(ref.id, options?.keyPrefix)}`;
  }

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = metaById.get(id);
      if (existing) return existing;

      const key = mediaObjectKey(id, options?.keyPrefix);
      const head = await client.headObject(key);
      if (head) {
        const ref: MediaRef = {
          id,
          mime: head.mime,
          size: head.size,
          ...(head.meta === undefined ? {} : { meta: head.meta }),
        };
        metaById.set(id, ref);
        createdAtById.set(id, new Date().toISOString());
        return ref;
      }

      const ref: MediaRef = {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      await client.putObject({
        key,
        bytes: new Uint8Array(bytes),
        mime,
        ...(ref.meta === undefined ? {} : { meta: ref.meta }),
      });
      metaById.set(id, ref);
      createdAtById.set(id, new Date().toISOString());
      return ref;
    },

    async get(ref) {
      const object = await client.getObject(mediaObjectKey(ref.id, options?.keyPrefix));
      if (!object) throw new Error(`Media asset not found: ${ref.id}`);
      return new Uint8Array(object.bytes);
    },

    async exists(id) {
      return (await client.headObject(mediaObjectKey(id, options?.keyPrefix))) != null;
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const key = mediaObjectKey(ref.id, options?.keyPrefix);
      if ((await client.headObject(key)) == null) throw new Error(`Media asset not found: ${ref.id}`);
      return client.createSignedGetUrl ? client.createSignedGetUrl(key) : makeUrl(ref);
    },

    async delete(id) {
      await client.deleteObject(mediaObjectKey(id, options?.keyPrefix));
      owners.delete(id);
      metaById.delete(id);
      createdAtById.delete(id);
      for (const set of refs.values()) {
        set.delete(id);
      }
      for (const [key, row] of refRows) {
        if (row.mediaId === id) refRows.delete(key);
      }
    },

    async lookup(id) {
      const key = mediaObjectKey(id, options?.keyPrefix);
      const object = await client.headObject(key);
      if (!object) return null;
      const owner = owners.get(id);
      return {
        id,
        mime: object.mime,
        size: object.size,
        ownerSessionId: owner?.sessionId ?? null,
        ownerPluginId: owner?.pluginId ?? null,
      };
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      if (!(await this.exists(id))) return;
      const existing = owners.get(id);
      if (existing && existing.sessionId !== ownerSessionId) return;
      owners.set(id, {
        sessionId: ownerSessionId,
        pluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      if (!(await this.exists(id))) return;
      addRefInternal(sessionId, id);
      // First writer wins for plugin_id — keyed only on (sessionId, mediaId)
      // to mirror the UNIQUE constraint enforced by SQLite/PG.
      const key = `${sessionId}\u0000${id}`;
      if (!refRows.has(key)) {
        refRows.set(key, {
          sessionId,
          mediaId: id,
          pluginId: pluginId ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    },

    async isReferencedBy(id, sessionId) {
      const owner = owners.get(id);
      if (owner?.sessionId === sessionId) return true;
      return refs.get(sessionId)?.has(id) ?? false;
    },

    async listAssets() {
      const rows: MediaAssetRecord[] = [];
      for (const [id, ref] of metaById) {
        const object = await client.headObject(mediaObjectKey(id, options?.keyPrefix));
        if (!object) continue;
        const owner = owners.get(id);
        rows.push({
          id,
          mime: object.mime,
          size: object.size,
          ownerSessionId: owner?.sessionId ?? null,
          ownerPluginId: owner?.pluginId ?? null,
          createdAt: createdAtById.get(id) ?? new Date(0).toISOString(),
          ...(object.meta === undefined ? ref.meta === undefined ? {} : { meta: ref.meta } : { meta: object.meta }),
        });
      }
      return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    async listRefs() {
      return [...refRows.values()];
    },

    async cleanup(protectedIds, policy) {
      const { result, idsToDelete } = cleanupCandidates(await this.listAssets(), protectedIds, policy);
      if (!policy?.dryRun) {
        for (const id of idsToDelete) {
          await this.delete(id);
        }
      }
      return result;
    },

    async openReadStream(ref) {
      const bytes = await this.get(ref);
      return bytesToReadableStream(await toBytes(bytes));
    },
  };
}

export function createSqliteMediaStore(
  dbPath: string,
  options?: SqliteMediaStoreOptions,
): MediaStore {
  const dbDir = dirname(dbPath);
  if (dbDir && dbDir !== '.' && dbDir !== ':memory:') {
    mkdirSync(dbDir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  createTables(sqlite);

  const mediaRoot = resolve(options?.mediaRoot ?? join(dbDir === ':memory:' ? process.cwd() : dbDir, 'media'));
  mkdirSync(mediaRoot, { recursive: true });

  const insertAsset = sqlite.prepare(`
    INSERT INTO media_assets (id, sha256, mime, size, path, meta, created_at)
    VALUES (@id, @sha256, @mime, @size, @path, @meta, @createdAt)
    ON CONFLICT(id) DO NOTHING
  `);
  const select = sqlite.prepare(
    'SELECT id, mime, size, path, meta, owner_session_id AS ownerSessionId, owner_plugin_id AS ownerPluginId FROM media_assets WHERE id = ?',
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
  const remove = sqlite.prepare('DELETE FROM media_assets WHERE id = ?');
  const removeRefs = sqlite.prepare('DELETE FROM media_refs WHERE media_id = ?');

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
  const checkOwner = sqlite.prepare(
    'SELECT owner_session_id AS ownerSessionId FROM media_assets WHERE id = ?',
  );
  const checkRef = sqlite.prepare(
    'SELECT 1 AS one FROM media_refs WHERE session_id = ? AND media_id = ? LIMIT 1',
  );

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const existing = select.get(id) as { id: string; mime: string; size: number; meta: string | null } | undefined;
      if (existing) {
        return {
          id: existing.id,
          mime: existing.mime,
          size: existing.size,
          ...(existing.meta ? { meta: JSON.parse(existing.meta) as Readonly<Record<string, unknown>> } : {}),
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

    async isReferencedBy(id, sessionId) {
      const ownerRow = checkOwner.get(id) as { ownerSessionId: string | null } | undefined;
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
        ...(row.meta ? { meta: JSON.parse(row.meta) as Readonly<Record<string, unknown>> } : {}),
      }));
    },

    async listRefs() {
      return selectAllRefs.all() as MediaRefRecord[];
    },

    async cleanup(protectedIds, policy) {
      const { result, idsToDelete } = cleanupCandidates(await this.listAssets(), protectedIds, policy);
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
  };
}
