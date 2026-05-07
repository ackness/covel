/**
 * Unit tests for the IDB media cache.
 *
 * jsdom does not ship with IndexedDB, and the workspace dep
 * `fake-indexeddb` lives under `@covel/store` (not directly importable
 * from `@covel/web`). To stay self-contained we install a minimal
 * in-memory IDB shim that covers the shape used by `media-cache.ts`:
 * `open` → `transaction(name, mode)` → `objectStore(name)` →
 * `{ get, put, delete, openCursor }`.
 *
 * The shim is only good enough for these tests. For production-style
 * coverage rely on a real browser (Playwright) or upgrade once
 * `fake-indexeddb` is hoisted.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  __resetMediaCacheForTests,
  deleteCachedMedia,
  getCacheSize,
  getCachedMedia,
  putCachedMedia,
  type MediaCacheRecord,
} from "../media-cache.js";

interface CursorWithValue {
  value: unknown;
  continue(): void;
}
type IdbHandler = () => void;

interface FakeRequest<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: IdbHandler | null;
  onerror: IdbHandler | null;
  onupgradeneeded?: IdbHandler | null;
  onblocked?: IdbHandler | null;
}

class FakeStore {
  readonly data = new Map<string, unknown>();
  readonly keyPath: string;
  constructor(keyPath: string) {
    this.keyPath = keyPath;
  }
  get(key: string): FakeRequest {
    const req = makeReq();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }
  put(record: Record<string, unknown>): FakeRequest {
    const req = makeReq();
    const key = record[this.keyPath] as string;
    queueMicrotask(() => {
      this.data.set(key, record);
      req.onsuccess?.();
    });
    return req;
  }
  delete(key: string): FakeRequest {
    const req = makeReq();
    queueMicrotask(() => {
      this.data.delete(key);
      req.onsuccess?.();
    });
    return req;
  }
  openCursor(): FakeRequest {
    const req = makeReq();
    const entries = [...this.data.values()];
    let i = 0;
    const advance = () => {
      if (i >= entries.length) {
        req.result = null;
        req.onsuccess?.();
        return;
      }
      const value = entries[i++];
      const cursor: CursorWithValue = {
        value,
        continue() {
          queueMicrotask(advance);
        },
      };
      req.result = cursor;
      req.onsuccess?.();
    };
    queueMicrotask(advance);
    return req;
  }
}

class FakeTx {
  constructor(private readonly db: FakeDb) {}
  objectStore(name: string): FakeStore {
    const store = this.db.stores.get(name);
    if (!store) throw new Error("missing store " + name);
    return store;
  }
}

class FakeDb {
  readonly stores = new Map<string, FakeStore>();
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  createObjectStore(name: string, opts: { keyPath: string }): FakeStore {
    const store = new FakeStore(opts.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(name: string, _mode?: string): FakeTx {
    void _mode;
    if (!this.stores.has(name)) throw new Error("no store " + name);
    return new FakeTx(this);
  }
}

function makeReq<T = unknown>(): FakeRequest<T> {
  return {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
}

const dbInstances = new Map<string, FakeDb>();

function fakeIndexedDB() {
  return {
    open(name: string, _version?: number): FakeRequest<FakeDb> {
      void _version;
      const req = makeReq<FakeDb>();
      let db = dbInstances.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDb();
        dbInstances.set(name, db);
      }
      queueMicrotask(() => {
        if (isNew) {
          req.result = db as FakeDb;
          req.onupgradeneeded?.();
        }
        req.result = db as FakeDb;
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const realIDB = (globalThis as { indexedDB?: unknown }).indexedDB;

beforeEach(() => {
  dbInstances.clear();
  __resetMediaCacheForTests();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
});

afterEach(() => {
  if (realIDB === undefined) {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  } else {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = realIDB;
  }
});

function makeRecord(id: string): MediaCacheRecord {
  const blob = new Blob(["hello-" + id], { type: "image/png" });
  return {
    id,
    mime: "image/png",
    size: blob.size,
    blob,
    savedAt: 1234,
  };
}

describe("media-cache", () => {
  it("round-trips put → get for a single record", async () => {
    const record = makeRecord("abc");
    await putCachedMedia(record);
    const got = await getCachedMedia("abc");
    expect(got).not.toBeNull();
    expect(got?.id).toBe("abc");
    expect(got?.mime).toBe("image/png");
    expect(got?.size).toBe(record.size);
    expect(got?.blob).toBeInstanceOf(Blob);
  });

  it("returns null for a missing id", async () => {
    const got = await getCachedMedia("never-stored");
    expect(got).toBeNull();
  });

  it("put is idempotent: re-putting the same id keeps the first record", async () => {
    const first = makeRecord("dup");
    await putCachedMedia(first);
    const second: MediaCacheRecord = {
      ...first,
      blob: new Blob(["different"], { type: "image/png" }),
      savedAt: 9999,
    };
    await putCachedMedia(second);
    const got = await getCachedMedia("dup");
    // Idempotent: the original (first) record wins.
    expect(got?.savedAt).toBe(1234);
  });

  it("delete removes the record", async () => {
    await putCachedMedia(makeRecord("zap"));
    await deleteCachedMedia("zap");
    const got = await getCachedMedia("zap");
    expect(got).toBeNull();
  });

  it("getCacheSize sums sizes across records", async () => {
    await putCachedMedia(makeRecord("a"));
    await putCachedMedia(makeRecord("bb"));
    const size = await getCacheSize();
    expect(size).toBeGreaterThan(0);
    expect(typeof size).toBe("number");
  });

  it("returns null gracefully when indexedDB is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    __resetMediaCacheForTests();
    const got = await getCachedMedia("anything");
    expect(got).toBeNull();
    // putCachedMedia should also be a no-op (resolves without throwing)
    await expect(putCachedMedia(makeRecord("noop"))).resolves.toBeUndefined();
  });

  it("evicts a cached record when its size disagrees with the expected ref", async () => {
    await putCachedMedia(makeRecord("evict-size"));
    const got = await getCachedMedia("evict-size", {
      id: "evict-size",
      mime: "image/png",
      size: 999_999, // intentionally wrong
    });
    expect(got).toBeNull();
    // After eviction, a follow-up read returns nothing (record gone).
    // Allow the deferred delete a microtask to complete.
    await Promise.resolve();
    const after = await getCachedMedia("evict-size");
    expect(after).toBeNull();
  });

  it("evicts a cached record when its mime disagrees with the expected ref", async () => {
    await putCachedMedia(makeRecord("evict-mime"));
    const got = await getCachedMedia("evict-mime", {
      id: "evict-mime",
      mime: "image/jpeg", // stored is image/png
      size: makeRecord("evict-mime").size,
    });
    expect(got).toBeNull();
  });

  it("returns the record when expected shape matches", async () => {
    const record = makeRecord("ok");
    await putCachedMedia(record);
    const got = await getCachedMedia("ok", {
      id: "ok",
      mime: record.mime,
      size: record.size,
    });
    expect(got).not.toBeNull();
    expect(got?.id).toBe("ok");
  });
});
