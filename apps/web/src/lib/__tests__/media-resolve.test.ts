/**
 * Unit tests for `resolveMediaSrc`.
 *
 * Covers the four resolution paths in SPEC §5.1 (g):
 *   1. token endpoint authorizes the current session
 *   2. cache hit after authorization
 *   3. signed URL fetch
 *   4. explicit error result on failure
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
const realWindowTauri = window.__TAURI__;
type TauriInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

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
  delete window.__TAURI__;
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
  if (realWindowTauri === undefined) {
    delete window.__TAURI__;
  } else {
    window.__TAURI__ = realWindowTauri;
  }
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

  it("uses the server-issued signed URL after authorization", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://cdn.example.com/abc.png" };
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(url);
      if (url.startsWith("/api/sessions/")) {
        return new Response(
          JSON.stringify({ url: "https://signed.example.com/abc.png?token=xyz" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(pngBlob(), { status: 200 });
    });
    const result = await resolveMediaSrc(refWithUrl, { sessionId: "s1" });
    expect(calls).toEqual([
      MEDIA_TOKEN_ENDPOINT("s1", "sha256-abc"),
      "https://signed.example.com/abc.png?token=xyz",
    ]);
    expect(result.fromCache).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.url.startsWith("blob:")).toBe(true);
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it("uses the Tauri native media bridge before the HTTP path", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe("native_media_read");
      expect(args).toEqual({ id: "sha256-abc" });
      return {
        id: "sha256-abc",
        size: 14,
        bytes: Array.from(new TextEncoder().encode("fake-png-bytes")),
      };
    });
    window.__TAURI__ = {
      core: { invoke: invoke as unknown as TauriInvoke },
    };
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    const result = await resolveMediaSrc(baseRef, { sessionId: "s-tauri" });

    expect(result.ok).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.url.startsWith("blob:")).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    expect(result.ok).toBe(true);
  });

  it("returns an error result when authorization fails", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    const result = await resolveMediaSrc(
      { ...baseRef, url: "https://broken.example.com/x.png" },
      { sessionId: "s3" },
    );
    expect(result.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
    expect(result.fromCache).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("uses cache hit after authorizing the session", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://cdn.example.com/cached.png" };
    let tokenFetchCount = 0;
    let blobFetchCount = 0;
    mockFetch(async (url) => {
      if (url.startsWith("/api/sessions/")) {
        tokenFetchCount += 1;
        return new Response(
          JSON.stringify({ url: "https://signed.example.com/cached.png?token=xyz" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      blobFetchCount += 1;
      return new Response(pngBlob(), { status: 200 });
    });

    const first = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
    expect(first.fromCache).toBe(false);
    expect(first.ok).toBe(true);
    expect(tokenFetchCount).toBe(1);
    expect(blobFetchCount).toBe(1);

    const second = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
    expect(second.fromCache).toBe(true);
    expect(second.ok).toBe(true);
    expect(tokenFetchCount).toBe(2);
    expect(blobFetchCount).toBe(1);
    expect(second.url.startsWith("blob:")).toBe(true);
  });

  it("does not serve a cached blob when a different session fails authorization", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://cdn.example.com/cached.png" };
    mockFetch(async (url) => {
      if (url.startsWith("/api/sessions/s4/")) {
        return new Response(
          JSON.stringify({ url: "https://signed.example.com/cached.png?token=xyz" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("/api/sessions/s5/")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response(pngBlob(), { status: 200 });
    });

    const first = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
    expect(first.ok).toBe(true);

    const second = await resolveMediaSrc(refWithUrl, { sessionId: "s5" });
    expect(second.fromCache).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
  });

  it("ignores stale ref.url and fetches via the token endpoint", async () => {
    const refWithUrl: MediaRef = { ...baseRef, url: "https://broken.example.com/x.png" };
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(url);
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
    expect(calls).toEqual([
      MEDIA_TOKEN_ENDPOINT("s5", "sha256-abc"),
      "https://recovered.example.com/x.png",
    ]);
  });
});
