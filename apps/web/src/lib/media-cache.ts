/**
 * IndexedDB blob cache for MediaRef-addressed assets.
 *
 * - DB name:    `covel-browser`
 * - Store:      `media_cache_blobs` (keyPath `id`, content-addressable SHA-256)
 * - Schema:     `MediaCacheRecord`
 *
 * The cache is content-addressable, so writes are idempotent: writing the
 * same `id` twice is a no-op (we keep the first record). LRU eviction is
 * intentionally deferred to P2 — see SPEC §5.1 (i).
 *
 * All failures are swallowed and logged via `console.warn`. The cache is
 * a soft optimisation: if IDB is unavailable (private mode, quota
 * exhausted, schema upgrade failure) the rendering layer must still
 * function via the network fallback in `media-resolve.ts`.
 */

import {
  BROWSER_IDB_SCHEMA_VERSION,
  MEDIA_CACHE_STORE_BLOBS,
  upgradeBrowserIdbSchema,
} from "@covel/store/idb";
import { BROWSER_STORAGE_DB_NAME } from "@/services/storage";

const DB_NAME = BROWSER_STORAGE_DB_NAME;
const DB_VERSION = BROWSER_IDB_SCHEMA_VERSION;
const STORE_BLOBS = MEDIA_CACHE_STORE_BLOBS;

export interface MediaCacheRecord {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: Blob;
  readonly savedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isIdbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openMediaDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (!isIdbAvailable()) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err: unknown) {
      console.warn("[media-cache] indexedDB.open threw", err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = (event) => {
      upgradeBrowserIdbSchema(req.result, event.oldVersion);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[media-cache] indexedDB.open error", req.error);
      resolve(null);
    };
    req.onblocked = () => {
      console.warn("[media-cache] indexedDB.open blocked");
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Reset the cached `dbPromise`. Test-only — production callers should
 * never need this. Exported under a __test prefix to make the contract
 * obvious. Not in public surface.
 */
export function __resetMediaCacheForTests(): void {
  dbPromise = null;
}

/**
 * Optional structural shape used to verify a cached record at read time.
 * Mirrors the relevant `MediaRef` fields without coupling this module to
 * the shared types package — keeps the cache reusable from any caller
 * that wants the integrity guarantee.
 */
export interface ExpectedRecordShape {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
}

export async function getCachedMedia(
  id: string,
  expected?: ExpectedRecordShape,
): Promise<MediaCacheRecord | null> {
  const db = await openMediaDb();
  if (!db) return null;
  const record = await new Promise<MediaCacheRecord | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_BLOBS, "readonly");
    } catch (err: unknown) {
      console.warn("[media-cache] getCachedMedia tx error", err);
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE_BLOBS);
    const req = store.get(id);
    req.onsuccess = () => {
      const result = req.result as MediaCacheRecord | undefined;
      resolve(result ?? null);
    };
    req.onerror = () => {
      console.warn("[media-cache] getCachedMedia error", req.error);
      resolve(null);
    };
  });
  if (!record) return null;
  if (expected && !cachedRecordMatches(record, expected)) {
    console.warn(
      "[media-cache] evicting cached record — does not match expected ref",
      {
        id: expected.id,
        expected,
        cached: { id: record.id, mime: record.mime, size: record.size },
      },
    );
    // Fire-and-forget eviction; never block the read path on cleanup.
    void deleteCachedMedia(id);
    return null;
  }
  return record;
}

function cachedRecordMatches(
  record: MediaCacheRecord,
  expected: ExpectedRecordShape,
): boolean {
  if (record.id !== expected.id) return false;
  if (record.size !== expected.size) return false;
  if (record.blob.size !== expected.size) return false;
  if (expected.mime && record.mime && record.mime !== expected.mime) {
    return false;
  }
  return true;
}

export async function putCachedMedia(record: MediaCacheRecord): Promise<void> {
  const db = await openMediaDb();
  if (!db) return;
  // Idempotent: if the id already exists, skip the write. Content-addressable
  // ids guarantee that the bytes match, so re-writing wastes I/O.
  const existing = await getCachedMedia(record.id);
  if (existing) return;

  return new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_BLOBS, "readwrite");
    } catch (err: unknown) {
      console.warn("[media-cache] putCachedMedia tx error", err);
      resolve();
      return;
    }
    const store = tx.objectStore(STORE_BLOBS);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      console.warn("[media-cache] putCachedMedia error", req.error);
      resolve();
    };
  });
}

export async function deleteCachedMedia(id: string): Promise<void> {
  const db = await openMediaDb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_BLOBS, "readwrite");
    } catch (err: unknown) {
      console.warn("[media-cache] deleteCachedMedia tx error", err);
      resolve();
      return;
    }
    const store = tx.objectStore(STORE_BLOBS);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      console.warn("[media-cache] deleteCachedMedia error", req.error);
      resolve();
    };
  });
}

/**
 * Aggregate blob byte size across all cached records.
 * Useful for an admin / debug view; not used during normal rendering.
 */
export async function getCacheSize(): Promise<number> {
  const db = await openMediaDb();
  if (!db) return 0;
  return new Promise<number>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_BLOBS, "readonly");
    } catch (err: unknown) {
      console.warn("[media-cache] getCacheSize tx error", err);
      resolve(0);
      return;
    }
    const store = tx.objectStore(STORE_BLOBS);
    const req = store.openCursor();
    let total = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(total);
        return;
      }
      const record = cursor.value as MediaCacheRecord | undefined;
      if (
        record &&
        typeof record.size === "number" &&
        Number.isFinite(record.size)
      ) {
        total += record.size;
      }
      cursor.continue();
    };
    req.onerror = () => {
      console.warn("[media-cache] getCacheSize error", req.error);
      resolve(total);
    };
  });
}
