import type { MediaRef } from '@covel/shared';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MediaAssetLookup, MediaStore } from '../media-store.js';

const DEFAULT_DB_NAME = 'covel-media-store';
const DB_VERSION = 2;
const STORE_ASSETS = 'media_assets';
const STORE_REFS = 'media_refs';

interface IdbMediaAssetRecord {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: Blob;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly ownerSessionId: string | null;
  readonly ownerPluginId: string | null;
  readonly createdAt: string;
}

interface IdbMediaRefRecord {
  readonly key: string;
  readonly mediaId: string;
  readonly sessionId: string;
  readonly pluginId: string | null;
  readonly createdAt: string;
}

interface IdbMediaDb extends DBSchema {
  readonly [STORE_ASSETS]: {
    key: string;
    value: IdbMediaAssetRecord;
    indexes: {
      readonly owner: [string, string];
    };
  };
  readonly [STORE_REFS]: {
    key: string;
    value: IdbMediaRefRecord;
    indexes: {
      readonly sessionId: string;
      readonly mediaId: string;
      readonly session_media: [string, string];
    };
  };
}

export interface IndexedDbMediaStoreOptions {
  readonly dbName?: string;
}

async function openMediaDb(dbName: string): Promise<IDBPDatabase<IdbMediaDb>> {
  return openDB<IdbMediaDb>(dbName, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        const assets = db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
        assets.createIndex('owner', ['ownerSessionId', 'ownerPluginId']);
      }
      if (!db.objectStoreNames.contains(STORE_REFS)) {
        const refs = db.createObjectStore(STORE_REFS, { keyPath: 'key' });
        refs.createIndex('sessionId', 'sessionId');
        refs.createIndex('mediaId', 'mediaId');
        refs.createIndex('session_media', ['sessionId', 'mediaId']);
      }
    },
  });
}

async function toBlobAndBytes(value: Uint8Array | Blob, fallbackMime: string): Promise<{
  readonly blob: Blob;
  readonly bytes: Uint8Array;
}> {
  if (value instanceof Blob) {
    return {
      blob: value.type === fallbackMime ? value : value.slice(0, value.size, fallbackMime),
      bytes: new Uint8Array(await value.arrayBuffer()),
    };
  }
  const bytes = new Uint8Array(value);
  return {
    blob: new Blob([bytes], { type: fallbackMime }),
    bytes,
  };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return bytesToHex(digest);
}

function toMediaRef(record: IdbMediaAssetRecord): MediaRef {
  return {
    id: record.id,
    mime: record.mime,
    size: record.size,
    ...(record.meta === undefined ? {} : { meta: record.meta }),
  };
}

function toLookup(record: IdbMediaAssetRecord): MediaAssetLookup {
  return {
    id: record.id,
    mime: record.mime,
    size: record.size,
    ownerSessionId: record.ownerSessionId,
    ownerPluginId: record.ownerPluginId,
  };
}

function refKey(mediaId: string, sessionId: string, pluginId?: string): string {
  return `${sessionId}\u0000${mediaId}\u0000${pluginId ?? ''}`;
}

function cloneMeta(meta?: object): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined ? undefined : { ...(meta as Record<string, unknown>) };
}

export async function createIndexedDbMediaStore(
  options?: IndexedDbMediaStoreOptions,
): Promise<MediaStore> {
  const db = await openMediaDb(options?.dbName ?? DEFAULT_DB_NAME);

  return {
    async put(value, mime, meta) {
      const { blob, bytes } = await toBlobAndBytes(value, mime);
      const id = await sha256(bytes);
      const existing = await db.get(STORE_ASSETS, id);
      if (existing) return toMediaRef(existing);

      const record: IdbMediaAssetRecord = {
        id,
        mime,
        size: bytes.byteLength,
        blob,
        ...(meta === undefined ? {} : { meta: cloneMeta(meta) }),
        ownerSessionId: null,
        ownerPluginId: null,
        createdAt: new Date().toISOString(),
      };
      await db.put(STORE_ASSETS, record);
      return toMediaRef(record);
    },

    async get(ref) {
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return record.blob;
    },

    async exists(id) {
      return (await db.getKey(STORE_ASSETS, id)) !== undefined;
    },

    async resolveUrl(ref) {
      if (ref.url) return ref.url;
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return URL.createObjectURL(record.blob);
    },

    async delete(id) {
      const tx = db.transaction([STORE_ASSETS, STORE_REFS], 'readwrite');
      await Promise.all([
        tx.objectStore(STORE_ASSETS).delete(id),
        (async () => {
          let cursor = await tx.objectStore(STORE_REFS).index('mediaId').openCursor(id);
          while (cursor) {
            await cursor.delete();
            cursor = await cursor.continue();
          }
        })(),
      ]);
      await tx.done;
    },

    async lookup(id) {
      const record = await db.get(STORE_ASSETS, id);
      return record ? toLookup(record) : null;
    },

    async recordOwnership(id, ownerSessionId, ownerPluginId) {
      const record = await db.get(STORE_ASSETS, id);
      if (!record) return;
      if (record.ownerSessionId !== null && record.ownerSessionId !== ownerSessionId) return;
      await db.put(STORE_ASSETS, {
        ...record,
        ownerSessionId,
        ownerPluginId: ownerPluginId ?? null,
      });
    },

    async addRef(id, sessionId, pluginId) {
      const exists = await db.getKey(STORE_ASSETS, id);
      if (exists === undefined) return;
      await db.put(STORE_REFS, {
        key: refKey(id, sessionId, pluginId),
        mediaId: id,
        sessionId,
        pluginId: pluginId ?? null,
        createdAt: new Date().toISOString(),
      });
    },

    async isReferencedBy(id, sessionId) {
      const record = await db.get(STORE_ASSETS, id);
      if (record?.ownerSessionId === sessionId) return true;
      const key = await db.getKeyFromIndex(STORE_REFS, 'session_media', [sessionId, id]);
      return key !== undefined;
    },

    async openReadStream(ref) {
      const record = await db.get(STORE_ASSETS, ref.id);
      if (!record) throw new Error(`Media asset not found: ${ref.id}`);
      return record.blob.stream() as ReadableStream<Uint8Array>;
    },
  };
}
