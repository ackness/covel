/**
 * Integration tests for `GET /api/media/:id` (SPEC §5.1 g).
 *
 * Uses a hand-rolled in-memory MediaStore so we can test the route
 * without depending on Codex A's real implementation. Asserts:
 *   - 200 with proper headers + bytes
 *   - 401 / 403 / 404 / 304 / 503 branches
 *   - Streaming path engages for >1 MiB assets
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { MediaRef } from "@covel/shared";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type DataStore,
  type MediaAssetLookup,
  type MediaAssetRecord,
  type MediaRefRecord,
  type MediaStore,
  type SessionRecord,
} from "@covel/store";
import { mediaRoutes } from "../../src/routes/api/media.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import {
  _resetMediaTokenSecretForTests,
  signMediaTokenForSession,
} from "../../src/middleware/media-token.js";

const TEST_SECRET = "route-test-secret-" + "x".repeat(32);

function makeSession(id: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    worldId: "world-1",
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  };
}

interface StoredAsset {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly size: number;
  readonly createdAt?: string;
  /** `null` models the "ownership not yet recorded" state. */
  readonly ownerSessionId: string | null;
  readonly ownerPluginId?: string;
  readonly references: ReadonlySet<string>;
}

interface MockMediaStoreOptions {
  readonly streamCallCounter?: { count: number };
  readonly throwOnGet?: boolean;
  readonly throwOnLookup?: boolean;
}

function createMockMediaStore(options: MockMediaStoreOptions = {}): {
  readonly store: MediaStore;
  put(asset: StoredAsset): MediaRef;
} {
  const assets = new Map<string, StoredAsset>();
  const counter = options.streamCallCounter;

  const store: MediaStore = {
    async put(blob, mime) {
      const bytes =
        blob instanceof Uint8Array
          ? blob
          : new Uint8Array(await (blob as Blob).arrayBuffer());
      const id = createHash("sha256").update(bytes).digest("hex");
      assets.set(id, {
        bytes,
        mime,
        size: bytes.byteLength,
        ownerSessionId: "auto",
        references: new Set(["auto"]),
        createdAt: new Date().toISOString(),
      });
      return { id, mime, size: bytes.byteLength };
    },
    async get(ref) {
      if (options.throwOnGet) throw new Error("boom");
      const a = assets.get(ref.id);
      if (!a) throw new Error("missing");
      return a.bytes;
    },
    async exists(id) {
      return assets.has(id);
    },
    async resolveUrl() {
      return "/api/media/test";
    },
    async delete(id) {
      assets.delete(id);
    },
    async lookup(id): Promise<MediaAssetLookup | null> {
      if (options.throwOnLookup) throw new Error("boom");
      const a = assets.get(id);
      if (!a) return null;
      return {
        id,
        mime: a.mime,
        size: a.size,
        ownerSessionId: a.ownerSessionId,
        ownerPluginId: a.ownerPluginId ?? null,
      };
    },
    async recordOwnership() {
      // No-op: the test fixture sets ownership directly via the seed asset.
    },
    async addRef() {
      // No-op: the test fixture seeds references via the `references` set.
    },
    async removeRef() {
      // No-op: the test fixture seeds references via the `references` set.
    },
    async isReferencedBy(id, sessionId) {
      const a = assets.get(id);
      return a ? a.references.has(sessionId) : false;
    },
    async listAssets(): Promise<readonly MediaAssetRecord[]> {
      return [...assets.entries()].map(([id, asset]) => ({
        id,
        mime: asset.mime,
        size: asset.size,
        ownerSessionId: asset.ownerSessionId,
        ownerPluginId: asset.ownerPluginId ?? null,
        createdAt: asset.createdAt ?? new Date(0).toISOString(),
      }));
    },
    async listRefs(): Promise<readonly MediaRefRecord[]> {
      const rows: MediaRefRecord[] = [];
      for (const [mediaId, asset] of assets) {
        for (const sessionId of asset.references) {
          if (sessionId === asset.ownerSessionId) continue;
          rows.push({
            mediaId,
            sessionId,
            pluginId: null,
            createdAt: asset.createdAt ?? new Date(0).toISOString(),
          });
        }
      }
      return rows;
    },
    async listByMetadata(sessionId, filter) {
      // Keep this in sync with filterAssetsByMetadata in
      // packages/store/src/media-store/utils.ts.
      const rows = await this.listAssets();
      return rows.filter((row) => {
        if (row.ownerSessionId !== sessionId) return false;
        const meta = row.meta ?? {};
        return Object.entries(filter).every(([k, v]) => meta[k] === v);
      });
    },
    async cleanup(protectedIds, policy = {}) {
      const rows = await this.listAssets();
      const deletable = rows.filter((row) => !protectedIds.has(row.id));
      const idsToDelete =
        policy.maxBytes === undefined &&
        policy.maxAgeMs === undefined &&
        policy.keepRecentBytes === undefined
          ? []
          : deletable.map((row) => row.id);
      const bytesDeleted = rows
        .filter((row) => idsToDelete.includes(row.id))
        .reduce((sum, row) => sum + row.size, 0);
      if (!policy.dryRun) {
        for (const id of idsToDelete) assets.delete(id);
      }
      const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
      return {
        scanned: rows.length,
        protected: rows.filter((row) => protectedIds.has(row.id)).length,
        retained: rows.length - idsToDelete.length,
        deleted: idsToDelete.length,
        totalBytes,
        bytesDeleted,
        bytesRetained: totalBytes - bytesDeleted,
        protectedIds: [...protectedIds].sort(),
        deletedIds: idsToDelete,
      };
    },
    async openReadStream(ref) {
      if (counter) counter.count += 1;
      const a = assets.get(ref.id);
      if (!a) throw new Error("missing");
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Slice into chunks so the stream actually exercises ReadableStream.
          const CHUNK = 256 * 1024;
          for (let off = 0; off < a.bytes.byteLength; off += CHUNK) {
            controller.enqueue(
              a.bytes.subarray(off, Math.min(off + CHUNK, a.bytes.byteLength)),
            );
          }
          controller.close();
        },
      });
    },
  };

  return {
    store,
    put(asset) {
      const id = createHash("sha256").update(asset.bytes).digest("hex");
      assets.set(id, {
        ...asset,
        createdAt: asset.createdAt ?? new Date().toISOString(),
      });
      return { id, mime: asset.mime, size: asset.size };
    },
  };
}

function createTestApp(
  store: MediaStore | undefined,
  dataStore: DataStore = createMemoryStore(),
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", dataStore);
    if (store) {
      c.set("mediaStore", store);
    }
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/media", mediaRoutes);
  return app;
}

describe("GET /api/media/:id", () => {
  const ORIGINAL = process.env.COVEL_MEDIA_TOKEN_SECRET;

  beforeEach(() => {
    process.env.COVEL_MEDIA_TOKEN_SECRET = TEST_SECRET;
    _resetMediaTokenSecretForTests();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.COVEL_MEDIA_TOKEN_SECRET;
    } else {
      process.env.COVEL_MEDIA_TOKEN_SECRET = ORIGINAL;
    }
    _resetMediaTokenSecretForTests();
  });

  it("200 streams bytes back with correct headers when token + session match", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const ref = mock.put({
      bytes,
      mime: "image/png",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-A");

    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("etag")).toBe(`"${ref.id}"`);
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("400 when token query param is missing", async () => {
    const mock = createMockMediaStore();
    const app = createTestApp(mock.store);
    const res = await app.request(`/api/media/some-id`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
  });

  it("401 when token is malformed", async () => {
    const mock = createMockMediaStore();
    const app = createTestApp(mock.store);
    const res = await app.request(`/api/media/some-id?token=garbage`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("invalid_token");
  });

  it("401 when token id does not match URL parameter", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    // Token issued for a different id
    const token = signMediaTokenForSession("sha-other", "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(401);
  });

  it("403 when token verifies but session does not reference the asset", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-B");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("forbidden");
  });

  it("403 when ownership was never recorded (ownerSessionId === null and no media_refs row)", async () => {
    // After P0-a runtime wiring lands, every ctx.media.put() must call
    // recordOwnership(); an asset with ownerSessionId === null and no
    // media_refs row is now an integrity bug, not a permission bypass.
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([9, 9, 9]);
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: null,
      references: new Set(),
    });
    const token = signMediaTokenForSession(ref.id, "sess-anyone");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(403);
  });

  it("200 when ownership is via media_refs (not direct owner)", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([42]);
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      // sess-B is NOT the owner but references the asset (e.g. via fork)
      references: new Set(["sess-A", "sess-B"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-B");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
  });

  it("404 when MediaStore does not know the id", async () => {
    const mock = createMockMediaStore();
    const token = signMediaTokenForSession("sha-unknown", "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/sha-unknown?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("not_found");
  });

  it("304 when If-None-Match matches the etag", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([7, 7, 7]);
    const ref = mock.put({
      bytes,
      mime: "image/jpeg",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
      { headers: { "if-none-match": `"${ref.id}"` } },
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${ref.id}"`);
  });

  it("streams via openReadStream for >1 MiB assets", async () => {
    const counter = { count: 0 };
    const mock = createMockMediaStore({ streamCallCounter: counter });
    const bytes = new Uint8Array(2 * 1024 * 1024); // 2 MiB
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(counter.count).toBe(1);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
    // Spot-check first/last bytes
    expect(body[0]).toBe(bytes[0]);
    expect(body[body.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
  });

  it("does NOT call openReadStream for small assets (<=1 MiB)", async () => {
    const counter = { count: 0 };
    const mock = createMockMediaStore({ streamCallCounter: counter });
    const bytes = new Uint8Array(64 * 1024); // 64 KiB
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(counter.count).toBe(0);
  });

  it("503 when mediaStore is not wired (P0-a transitional)", async () => {
    const app = createTestApp(undefined);
    const token = signMediaTokenForSession("sha-x", "sess-A");
    const res = await app.request(
      `/api/media/sha-x?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("unavailable");
  });

  it("500 when MediaStore.lookup throws (does not leak details)", async () => {
    const mock = createMockMediaStore({ throwOnLookup: true });
    const token = signMediaTokenForSession("sha-x", "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/sha-x?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal");
    expect(body.error).not.toContain("boom");
  });

  it("500 when MediaStore.get throws on read", async () => {
    const mock = createMockMediaStore({ throwOnGet: true });
    const bytes = new Uint8Array([0]);
    const ref = mock.put({
      bytes,
      mime: "image/png",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const token = signMediaTokenForSession(ref.id, "sess-A");
    const app = createTestApp(mock.store);
    const res = await app.request(
      `/api/media/${ref.id}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("boom");
  });
});

describe("GET /api/sessions/:id/media-token", () => {
  const ORIGINAL = process.env.COVEL_MEDIA_TOKEN_SECRET;

  beforeEach(() => {
    process.env.COVEL_MEDIA_TOKEN_SECRET = TEST_SECRET;
    _resetMediaTokenSecretForTests();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.COVEL_MEDIA_TOKEN_SECRET;
    } else {
      process.env.COVEL_MEDIA_TOKEN_SECRET = ORIGINAL;
    }
    _resetMediaTokenSecretForTests();
  });

  it("returns a signed URL for an owned asset and that URL serves bytes", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const ref = mock.put({
      bytes,
      mime: "image/png",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const app = createTestApp(mock.store);

    const tokenRes = await app.request(
      `/api/sessions/sess-A/media-token?id=${encodeURIComponent(ref.id)}`,
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { url: string };
    expect(body.url).toMatch(new RegExp(`^/api/media/${ref.id}\\?token=`));

    const mediaRes = await app.request(body.url);
    expect(mediaRes.status).toBe(200);
    expect(new Uint8Array(await mediaRes.arrayBuffer())).toEqual(bytes);
  });

  it("returns a signed URL when the session has a media_refs row", async () => {
    const mock = createMockMediaStore();
    const bytes = new Uint8Array([1, 1, 2, 3, 5]);
    const ref = mock.put({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      ownerSessionId: "sess-A",
      references: new Set(["sess-B"]),
    });
    const app = createTestApp(mock.store);

    const res = await app.request(
      `/api/sessions/sess-B/media-token?id=${encodeURIComponent(ref.id)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(`/api/media/${ref.id}?token=`);
  });

  it("403 when the session has no media access", async () => {
    const mock = createMockMediaStore();
    const ref = mock.put({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "application/octet-stream",
      size: 3,
      ownerSessionId: "sess-A",
      references: new Set(["sess-A"]),
    });
    const app = createTestApp(mock.store);

    const res = await app.request(
      `/api/sessions/sess-B/media-token?id=${encodeURIComponent(ref.id)}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("media_forbidden");
  });

  it("404 when the media id is unknown", async () => {
    const mock = createMockMediaStore();
    const app = createTestApp(mock.store);

    const res = await app.request(
      "/api/sessions/sess-A/media-token?id=sha-unknown",
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("media_not_found");
  });

  it("503 when mediaStore is unavailable", async () => {
    const app = createTestApp(undefined);

    const res = await app.request("/api/sessions/sess-A/media-token?id=sha-x");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("media_store_unavailable");
  });
});

describe("POST /api/media/cleanup", () => {
  // The route is gated by COVEL_MEDIA_CLEANUP_ENABLED — these legacy
  // happy-path tests assume the gate is open. Dedicated gate-behaviour
  // assertions live in `media-cleanup.test.ts`.
  const ORIGINAL_FLAG = process.env.COVEL_MEDIA_CLEANUP_ENABLED;
  beforeEach(() => {
    process.env.COVEL_MEDIA_CLEANUP_ENABLED = "true";
  });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.COVEL_MEDIA_CLEANUP_ENABLED;
    } else {
      process.env.COVEL_MEDIA_CLEANUP_ENABLED = ORIGINAL_FLAG;
    }
  });

  it("dry-runs cleanup and protects assets referenced by live sessions", async () => {
    const dataStore = createMemoryStore();
    await dataStore.createSession(makeSession("sess-A"));
    const mediaStore = createMemoryMediaStore();
    const keep = await mediaStore.put(
      new Uint8Array([1, 2, 3, 4]),
      "application/octet-stream",
    );
    const remove = await mediaStore.put(
      new Uint8Array([9, 9, 9, 9]),
      "application/octet-stream",
    );
    await mediaStore.recordOwnership(keep.id, "sess-A", "plugin-A");

    const app = createTestApp(mediaStore, dataStore);
    const res = await app.request("/api/media/cleanup", {
      method: "POST",
      body: JSON.stringify({ maxBytes: keep.size, dryRun: true }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { deletedIds: string[]; protectedIds: string[]; deleted: number };
    };
    expect(body.result.protectedIds).toContain(keep.id);
    expect(body.result.deletedIds).toEqual([remove.id]);
    expect(body.result.deleted).toBe(1);
    expect(await mediaStore.exists(remove.id)).toBe(true);
  });

  it("uses dry-run inventory semantics when no cleanup policy is provided", async () => {
    const dataStore = createMemoryStore();
    const mediaStore = createMemoryMediaStore();
    const ref = await mediaStore.put(
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    const app = createTestApp(mediaStore, dataStore);
    const res = await app.request("/api/media/cleanup", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { deletedIds: string[]; deleted: number };
    };
    expect(body.result.deletedIds).toEqual([]);
    expect(body.result.deleted).toBe(0);
    expect(await mediaStore.exists(ref.id)).toBe(true);
  });

  it("rejects invalid cleanup policy types", async () => {
    const app = createTestApp(createMemoryMediaStore(), createMemoryStore());
    const res = await app.request("/api/media/cleanup", {
      method: "POST",
      body: JSON.stringify({ dryRun: "false" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
  });
});
