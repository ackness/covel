/**
 * Integration tests for `POST /api/media` (player image upload).
 */

import { describe, expect, it } from "vitest";
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

// A few non-empty bytes — content is irrelevant, the store content-addresses.
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

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
    c.set("sessionLock", sessionLock);
    if (mediaStore) c.set("mediaStore", mediaStore);
    await next();
  });
  app.route("/api/media", mediaRoutes);
  return { app, mediaStore, store, sessionLock };
}

describe("POST /api/media (upload)", () => {
  it("stores an image and returns a content-addressed ref the session can read", async () => {
    const { app, mediaStore } = await makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(200);
    const ref = (await res.json()) as {
      id: string;
      mime: string;
      size: number;
    };
    expect(ref.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.mime).toBe("image/png");
    expect(ref.size).toBe(IMG.byteLength);
    expect(await mediaStore!.isReferencedBy(ref.id, "s1")).toBe(true);
  });

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

  it("rejects an SVG upload — it would execute script on the app origin", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('//evil')</script></svg>`,
      ),
    });
    expect(res.status).toBe(400);
  });

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
