import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store";
import { mediaRoutes } from "../../src/routes/api/media.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import {
  hashSessionOwnerToken,
  verifyResolvedSessionRead,
} from "../../src/routes/api/session/session-guard.js";

const OWNER_TOKEN = "synthetic-media-owner-token";
const BYTES = new Uint8Array([1, 2, 3]);

async function createTestApp() {
  const store = createMemoryStore();
  const mediaStore = createMemoryMediaStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "media-session",
    worldId: null,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    metadata: {
      ownerTokenHash: hashSessionOwnerToken(OWNER_TOKEN),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
  const ref = await mediaStore.put(BYTES, "image/png");
  await mediaStore.recordOwnership(ref.id, "media-session");

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("mediaStore", mediaStore);
    await next();
    const staleRead = await verifyResolvedSessionRead(c);
    if (staleRead) c.res = staleRead;
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/media", mediaRoutes);
  return {
    app,
    tokenUrl: `/api/sessions/media-session/media-token?id=${ref.id}`,
  };
}

describe("media tokens in production browser-private mode", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORE_BACKEND", "memory");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "synthetic-media-signing-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "other-session-owner-token"])(
    "rejects a token request from an unauthorized caller (%s)",
    async (token) => {
      const { app, tokenUrl } = await createTestApp();
      const headers = token ? { "x-session-token": token } : undefined;
      const sessionRes = await app.request("/api/sessions/media-session", {
        headers,
      });
      expect(sessionRes.status).toBe(401);
      const res = await app.request(tokenUrl, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        code: "session_owner_required",
      });
    },
  );

  it("allows the session owner to obtain a usable media URL", async () => {
    const { app, tokenUrl } = await createTestApp();
    const res = await app.request(tokenUrl, {
      headers: { "x-session-token": OWNER_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const mediaRes = await app.request(body.url);
    expect(mediaRes.status).toBe(200);
    expect(new Uint8Array(await mediaRes.arrayBuffer())).toEqual(BYTES);
  });
});
