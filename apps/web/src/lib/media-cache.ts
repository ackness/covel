/**
 * Optional content-addressed render-blob cache, separate from game checkpoints.
 * Failures return a cache miss or complete without a write, allowing the
 * rendering layer to use its authorized network response. First writer wins.
 */
import { z } from "zod";
import { MEDIA_CACHE_STORE_BLOBS } from "@covel/store/idb-schema";
import { openBrowserCacheDb } from "@/services/storage/cache-db.js";

export interface MediaCacheRecord {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly blob: Blob;
  readonly savedAt: number;
}

const recordSchema = z
  .object({
    id: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    blob: z.instanceof(Blob),
    savedAt: z.number(),
  })
  .refine((record) => record.size === record.blob.size);

export interface ExpectedRecordShape {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
}

function warnCacheFailure(operation: string, error: unknown): void {
  // Browser errors and caller-supplied records can include sensitive details.
  console.warn(`[media-cache] ${operation} failed`, {
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  enqueue: (store: IDBObjectStore) => IDBRequest<T>,
  onResult?: (value: T, store: IDBObjectStore) => void,
): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openBrowserCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_CACHE_STORE_BLOBS, mode);
    const store = tx.objectStore(MEDIA_CACHE_STORE_BLOBS);
    let request: IDBRequest<T>;
    let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () =>
      reject(
        failure ?? tx.error ?? new Error("Media cache transaction aborted"),
      );
    try {
      request = enqueue(store);
      if (onResult)
        request.onsuccess = () => {
          try {
            onResult(request.result, store);
          } catch (error) {
            abort(error);
          }
        };
    } catch (error) {
      abort(error);
    }
  });
}

export async function getCachedMedia(
  id: string,
  expected?: ExpectedRecordShape,
): Promise<MediaCacheRecord | null> {
  const shape = expected && {
    id: expected.id,
    mime: expected.mime,
    size: expected.size,
  };
  try {
    const raw: unknown = await transact("readonly", (store) => store.get(id));
    if (raw === undefined) return null;
    const record = parseCachedRecord(raw, shape);
    if (!record) {
      console.warn("[media-cache] evicting invalid record", { mediaId: id });
      // Cleanup is best effort and must not delay an authorized network fetch.
      void evictInvalidRecord(id, shape);
      return null;
    }
    return record;
  } catch (error) {
    warnCacheFailure("read", error);
    return null;
  }
}

function parseCachedRecord(
  raw: unknown,
  expected?: ExpectedRecordShape,
): MediaCacheRecord | null {
  const parsed = recordSchema.safeParse(raw);
  return parsed.success &&
    (!expected || cachedRecordMatches(parsed.data, expected))
    ? parsed.data
    : null;
}

async function evictInvalidRecord(
  id: string,
  expected?: ExpectedRecordShape,
): Promise<void> {
  try {
    await transact(
      "readwrite",
      (store) => store.get(id),
      (current, store) => {
        // Another tab may repair the record after the read that scheduled eviction.
        if (current !== undefined && !parseCachedRecord(current, expected))
          store.delete(id);
      },
    );
  } catch (error) {
    warnCacheFailure("evict", error);
  }
}

function cachedRecordMatches(
  record: MediaCacheRecord,
  expected: ExpectedRecordShape,
): boolean {
  return (
    record.id === expected.id &&
    record.size === expected.size &&
    (!expected.mime || !record.mime || record.mime === expected.mime)
  );
}

export async function putCachedMedia(record: MediaCacheRecord): Promise<void> {
  try {
    // Zod copies the scalar metadata before waiting; Blob bytes are immutable.
    const owned = recordSchema.parse(record);
    await transact(
      "readwrite",
      (store) => store.get(owned.id),
      (existing, store) => {
        // Read and first insert share one transaction across all tabs.
        if (existing === undefined) store.put(owned);
      },
    );
  } catch (error) {
    warnCacheFailure("write", error);
  }
}

export async function deleteCachedMedia(id: string): Promise<void> {
  try {
    await transact("readwrite", (store) => store.delete(id));
  } catch (error) {
    warnCacheFailure("delete", error);
  }
}
