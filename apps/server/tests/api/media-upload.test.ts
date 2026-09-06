/**
 * Integration tests for `POST /api/media` (player image upload).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type DataStore,
  type MediaStore,
} from "@covel/store";
import { mediaRoutes } from "../../src/routes/api/media.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import type { SessionLock } from "../../src/lib/session-lock.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

// A few non-empty bytes — content is irrelevant, the store content-addresses.
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const OWNER = "synthetic-media-owner-a";
let requestTime = Date.now();

beforeEach(() => {
  // The exported route shares a rate-limit bucket across test app instances.
  vi.spyOn(Date, "now").mockReturnValue((requestTime += 60_001));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function makeApp(withStore = true): Promise<{
  app: Hono;
  mediaStore?: MediaStore;
  store: DataStore;
  sessionLock: SessionLock;
}> {
  const app = new Hono();
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    metadata: {
      ownerTokenHash: hashSessionOwnerToken(OWNER),
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: "s1",
    worldId: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const sessionLock = createInProcessSessionLock();
  let mediaStore: MediaStore | undefined;
  if (withStore) {
    mediaStore = createMemoryMediaStore();
  }
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("sessionLock", sessionLock);
    if (mediaStore) c.set("mediaStore", mediaStore);
    await next();
  });
  app.route("/api/media", mediaRoutes);
  return { app, mediaStore, store, sessionLock };
}

describe("POST /api/media (upload)", () => {
  it.each([
    { owner: OWNER, status: 409, code: "session_incarnation_changed" },
    {
      owner: "synthetic-media-owner-b",
      status: 401,
      code: "session_owner_required",
    },
  ])(
    "keeps the authorized incarnation when the session is replaced before its initial read returns ($status)",
    async ({ owner, status, code }) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DEPLOYMENT_TIER", "self");
      vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
      const { app, mediaStore, store, sessionLock } = await makeApp();
      const getSession = store.getSession.bind(store);
      vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
        const initial = await getSession(id);
        await sessionLock.withLock(id, async () => {
          await store.deleteSession(id);
          await store.createSession({
            ...initial!,
            metadata: {
              ownerTokenHash: hashSessionOwnerToken(owner),
              sessionIncarnationNonce: "replacement-incarnation",
            },
          });
        });
        return initial;
      });

      const response = await app.request("/api/media?sessionId=s1", {
        method: "POST",
        headers: { "content-type": "image/png", "x-session-token": OWNER },
        body: IMG,
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect((await getSession("s1"))?.metadata?.sessionIncarnationNonce).toBe(
        "replacement-incarnation",
      );
      const [asset] = await mediaStore!.listAssets();
      expect(asset?.ownerSessionId).toBeNull();
      expect(await mediaStore!.isReferencedBy(asset!.id, "s1")).toBe(false);
    },
  );

  it("revalidates the owner after storing the upload even without an incarnation change", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    const { app, mediaStore, store } = await makeApp();
    const put = mediaStore!.put.bind(mediaStore);
    vi.spyOn(mediaStore!, "put").mockImplementationOnce(async (...args) => {
      const ref = await put(...args);
      await store.updateSession("s1", {
        metadata: {
          ownerTokenHash: hashSessionOwnerToken("replacement-owner"),
        },
      });
      return ref;
    });

    const response = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png", "x-session-token": OWNER },
      body: IMG,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "session_owner_required",
    });
    const [asset] = await mediaStore!.listAssets();
    expect(asset?.ownerSessionId).toBeNull();
    expect(await mediaStore!.isReferencedBy(asset!.id, "s1")).toBe(false);
  });

  it.each(["image/png", " IMAGE/PNG ; charset=binary"])(
    "stores %s with a normalized image MIME the session can read",
    async (mime) => {
      const { app, mediaStore } = await makeApp();
      const res = await app.request("/api/media?sessionId=s1", {
        method: "POST",
        headers: { "content-type": mime },
        body: IMG,
      });
      expect(res.status).toBe(201);
      const ref = (await res.json()) as {
        id: string;
        mime: string;
        size: number;
      };
      expect(ref.id).toMatch(/^[0-9a-f]{64}$/);
      expect(ref.mime).toBe("image/png");
      expect(ref.size).toBe(IMG.byteLength);
      expect(await mediaStore!.isReferencedBy(ref.id, "s1")).toBe(true);
    },
  );

  it("does not bind an upload to a replacement session with the same id", async () => {
    const { app, mediaStore, store, sessionLock } = await makeApp();
    let releaseHolder!: () => void;
    let markHolderStarted!: () => void;
    const holderStarted = new Promise<void>((resolve) => {
      markHolderStarted = resolve;
    });
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = sessionLock.withLock("s1", async () => {
      markHolderStarted();
      await holderGate;
    });
    await holderStarted;

    const uploading = app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    while ((await mediaStore!.listAssets()).length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await store.deleteSession("s1");
    const recreatedAt = new Date(Date.now() + 1_000).toISOString();
    await store.createSession({
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "s1",
      worldId: null,
      status: "active",
      createdAt: recreatedAt,
      updatedAt: recreatedAt,
    });
    releaseHolder();
    await holder;

    const res = await uploading;
    expect(res.status).toBe(409);
    const [asset] = await mediaStore!.listAssets();
    expect(asset?.ownerSessionId).toBeNull();
    expect(await mediaStore!.isReferencedBy(asset!.id, "s1")).toBe(false);
  });

  it("rejects a missing sessionId", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/media", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-image content type", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: IMG,
    });
    expect(res.status).toBe(400);
  });

  it.each(["image/svg+xml", "image/SVG+XML", " IMAGE/SVG+XML ; charset=UTF-8"])(
    "rejects a scriptable SVG upload with MIME %s",
    async (mime) => {
      const { app, mediaStore } = await makeApp();
      const res = await app.request("/api/media?sessionId=s1", {
        method: "POST",
        headers: { "content-type": mime },
        body: new TextEncoder().encode(
          `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('//evil')</script></svg>`,
        ),
      });
      expect(res.status).toBe(400);
      expect(await mediaStore!.listAssets()).toEqual([]);
    },
  );

  it("rejects an empty body", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no media store is configured", async () => {
    const { app } = await makeApp(false);
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(503);
  });
});
