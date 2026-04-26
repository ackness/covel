/**
 * Unit tests for `resolveMediaSrc`.
 *
 * Covers the four resolution paths in SPEC §5.1 (g):
 *   1. cache hit (skipped here — exercised in media-cache.test.ts)
 *   2. ref.url already signed
 *   3. token endpoint
 *   4. sentinel data URI on failure
 *
 * Uses the same minimal IDB shim from `media-cache.test.ts`. The IDB
 * cache is reset between tests so we can isolate the network paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMediaCacheForTests } from "../media-cache.js";
import {
  resolveMediaSrc,
  MEDIA_TOKEN_ENDPOINT,
  __testing,
} from "../media-resolve.js";
import type { MediaRef } from "@covel/shared";

// ── Inline minimal IDB shim (same shape as media-cache.test.ts) ────

interface FakeReq<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
}

class FakeStore {
  data = new Map<string, unknown>();
  constructor(readonly keyPath: string) {}
  get(key: string): FakeReq {
    const req = mk();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }
  put(record: Record<string, unknown>): FakeReq {
    const req = mk();
    queueMicrotask(() => {
      this.data.set(record[this.keyPath] as string, record);
      req.onsuccess?.();
    });
    return req;
  }
  delete(): FakeReq {
    const req = mk();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  openCursor(): FakeReq {
    const req = mk();
    queueMicrotask(() => {
      req.result = null;
      req.onsuccess?.();
    });
    return req;
  }
}
class FakeTx {
  constructor(readonly db: FakeDb) {}
  objectStore(n: string): FakeStore {
    const s = this.db.stores.get(n);
    if (!s) throw new Error("missing store");
    return s;
  }
}
class FakeDb {
  stores = new Map<string, FakeStore>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(name: string, opts: { keyPath: string }): FakeStore {
    const s = new FakeStore(opts.keyPath);
    this.stores.set(name, s);
    return s;
  }
  transaction(name: string): FakeTx {
    if (!this.stores.has(name)) throw new Error("no store");
    return new FakeTx(this);
  }
}
function mk<T = unknown>(): FakeReq<T> {
  return { result: undefined as T, error: null, onsuccess: null, onerror: null };
}
const dbInstances = new Map<string, FakeDb>();
function fakeIndexedDB() {
  return {
    open(name: string): FakeReq<FakeDb> {
      const req = mk<FakeDb>();
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

// ── Test setup ─────────────────────────────────────────────────────

const realIDB = (globalThis as { indexedDB?: unknown }).indexedDB;
const realFetch = globalThis.fetch;
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

let createdUrls: string[] = [];

beforeEach(() => {
  dbInstances.clear();
  __resetMediaCacheForTests();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB();

  createdUrls = [];
  globalThis.URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    const id = "blob:test/" + (createdUrls.length + 1);
    createdUrls.push(id);
    void blob;
    return id;
  }) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  if (realIDB === undefined) {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  } else {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = realIDB;
  }
  globalThis.fetch = realFetch;
  globalThis.URL.createObjectURL = realCreateObjectURL;
  globalThis.URL.revokeObjectURL = realRevokeObjectURL;
});

function pngBlob(): Blob {
  return new Blob(["fake-png-bytes"], { type: "image/png" });
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("MEDIA_TOKEN_ENDPOINT", () => {
  it("encodes both sessionId and id", () => {
    const out = MEDIA_TOKEN_ENDPOINT("abc/def", "id with space");
    expect(out).toBe("/api/sessions/abc%2Fdef/media-token?id=id%20with%20space");
  });
});

describe("resolveMediaSrc", () => {
  const baseRef: MediaRef = {
    id: "sha256-abc",
    mime: "image/png",
    size: 14,
  };

  it("uses ref.url directly when provided (path 2)", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://cdn.example.com/abc.png" };
    let calledUrl = "";
    mockFetch(async (url) => {
      calledUrl = url;
      return new Response(pngBlob(), { status: 200 });
    });
    const result = await resolveMediaSrc(refWithUrl, { sessionId: "s1" });
    expect(calledUrl).toBe("https://cdn.example.com/abc.png");
    expect(result.fromCache).toBe(false);
    expect(result.url.startsWith("blob:")).toBe(true);
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it("falls back to media-token endpoint when ref.url is absent (path 3)", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(url);
      if (url.startsWith("/api/sessions/")) {
        return new Response(
          JSON.stringify({ url: "https://signed.example.com/sha256-abc?token=xyz" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(pngBlob(), { status: 200 });
    });
    const result = await resolveMediaSrc(baseRef, { sessionId: "s2" });
    expect(calls[0]).toBe(MEDIA_TOKEN_ENDPOINT("s2", "sha256-abc"));
    expect(calls[1]).toBe("https://signed.example.com/sha256-abc?token=xyz");
    expect(result.url.startsWith("blob:")).toBe(true);
    expect(result.fromCache).toBe(false);
  });

  it("returns sentinel data URI when both ref.url and token endpoint fail (path 4)", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    const result = await resolveMediaSrc(
      { ...baseRef, url: "https://broken.example.com/x.png" },
      { sessionId: "s3" },
    );
    expect(result.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
    expect(result.fromCache).toBe(false);
  });

  it("uses cache hit on second call (path 1)", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://cdn.example.com/cached.png" };
    let fetchCount = 0;
    mockFetch(async () => {
      fetchCount += 1;
      return new Response(pngBlob(), { status: 200 });
    });

    const first = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
    expect(first.fromCache).toBe(false);
    expect(fetchCount).toBe(1);

    const second = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
    expect(second.fromCache).toBe(true);
    // Should not hit the network again.
    expect(fetchCount).toBe(1);
    expect(second.url.startsWith("blob:")).toBe(true);
  });

  it("falls through to token endpoint when ref.url returns non-2xx", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://broken.example.com/x.png" };
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(url);
      if (url === "https://broken.example.com/x.png") {
        return new Response("not found", { status: 404 });
      }
      if (url.startsWith("/api/sessions/")) {
        return new Response(
          JSON.stringify({ url: "https://recovered.example.com/x.png" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(pngBlob(), { status: 200 });
    });
    const result = await resolveMediaSrc(refWithUrl, { sessionId: "s5" });
    expect(result.url.startsWith("blob:")).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
