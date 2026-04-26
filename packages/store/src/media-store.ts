import type { MediaRef } from '@covel/shared';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTables } from './sqlite/sqlite-store-mappers.js';

export interface MediaStore {
  put(blob: Uint8Array | Blob, mime: string, meta?: object): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
}

export interface SqliteMediaStoreOptions {
  readonly mediaRoot?: string;
}

interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly ref: MediaRef;
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

export function createMemoryMediaStore(): MediaStore {
  const assets = new Map<string, StoredMedia>();

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
      const ref: MediaRef = {
        id,
        mime,
        size: bytes.byteLength,
        ...(meta === undefined ? {} : { meta: toMeta(meta) }),
      };
      assets.set(id, { bytes: new Uint8Array(bytes), ref });
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

  const upsert = sqlite.prepare(`
    INSERT INTO media_assets (id, sha256, mime, size, path, meta, created_at)
    VALUES (@id, @sha256, @mime, @size, @path, @meta, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      mime = excluded.mime,
      size = excluded.size,
      path = excluded.path,
      meta = excluded.meta
  `);
  const select = sqlite.prepare('SELECT id, mime, size, path, meta FROM media_assets WHERE id = ?');
  const remove = sqlite.prepare('DELETE FROM media_assets WHERE id = ?');

  return {
    async put(blob, mime, meta) {
      const bytes = await toBytes(blob);
      const id = sha256(bytes);
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
      upsert.run({
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
      remove.run(id);
      if (row?.path) {
        rmSync(row.path, { force: true });
      }
    },
  };
}
