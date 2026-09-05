import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import type { LLMAdapter } from "@covel/runtime";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
  type WorldRecord,
} from "@covel/store";
import { aiRoutes } from "../../src/routes/api/ai.js";
import { installRoutes } from "../../src/routes/api/install.js";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

const OPERATOR_TOKEN = "test-world-operator";
const OWNER_TOKEN = "test-world-session-owner";
const WORLD_ID = "shared-world";
const DIMENSIONS = { tone: { genres: ["mystery"], contentRating: "teen" } };
const WORLD: WorldRecord = {
  id: WORLD_ID,
  name: "Shared world",
  description: "Original shared world",
  metadata: { dimensions: {} },
  createdAt: "2026-08-25T00:00:00.000Z",
};
const MUTATIONS = [
  {
    method: "POST",
    url: "/api/worlds",
    body: { id: "new-world", name: "New world" },
    status: 201,
  },
  {
    method: "PATCH",
    url: `/api/worlds/${WORLD_ID}`,
    body: { description: "Updated world" },
    status: 200,
  },
  {
    method: "POST",
    url: `/api/worlds/${WORLD_ID}/dimensions/import`,
    body: { dimensions: DIMENSIONS },
    status: 200,
  },
  { method: "DELETE", url: `/api/worlds/${WORLD_ID}`, status: 200 },
] as const;

function authHeaders(token?: string) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

describe("browser-private shared world authorization", () => {
  let worldsDir: string;
  let stores: DataStore[];

  beforeEach(async () => {
    stores = [];
    worldsDir = await mkdtemp(path.join(tmpdir(), "covel-world-auth-"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("STORE_BACKEND", "memory");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", OPERATOR_TOKEN);
    vi.stubEnv("COVEL_INSTALL_API_ENABLED", "1");
    vi.stubEnv("COVEL_USER_WORLDS_DIR", worldsDir);
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await rm(worldsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function createApp(backend: "memory" | "sqlite" = "memory") {
    const store =
      backend === "memory"
        ? createMemoryStore()
        : createSqliteStore(":memory:");
    stores.push(store);
    await store.upsertWorld(WORLD);
    await store.createSession({
      id: "owned-session",
      worldId: WORLD_ID,
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [],
      locale: "en-US",
      metadata: { ownerTokenHash: hashSessionOwnerToken(OWNER_TOKEN) },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const generate = vi
      .fn<LLMAdapter["generate"]>()
      .mockRejectedValue(new Error("Unauthorized generation reached the LLM"));
    const app = new Hono();
    const eventBus = createEventBus();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("storeBackend", backend);
      c.set("eventBus", eventBus);
      c.set("worldsDirs", [worldsDir]);
      c.set("llmAdapter", { generate });
      await next();
    });
    app.route("/api/worlds", worldRoutes);
    app.route("/api/ai", aiRoutes);
    app.route("/api/install", installRoutes);
    return { app, store, generate };
  }

  async function mutate(
    app: Hono,
    mutation: (typeof MUTATIONS)[number],
    token?: string,
  ) {
    return app.request(mutation.url, {
      method: mutation.method,
      headers: { "content-type": "application/json", ...authHeaders(token) },
      ...("body" in mutation ? { body: JSON.stringify(mutation.body) } : {}),
    });
  }

  async function expectRejectedMutations(
    app: Hono,
    store: DataStore,
    token?: string,
  ) {
    const before = await store.listWorlds();
    for (const mutation of MUTATIONS) {
      const response = await mutate(app, mutation, token);
      expect(response.status, `${mutation.method} ${mutation.url}`).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "operator_token_required",
      });
      expect(await store.listWorlds()).toEqual(before);
    }
  }

  async function expectAllowedMutations(
    app: Hono,
    store: DataStore,
    token?: string,
  ) {
    for (const mutation of MUTATIONS) {
      const response = await mutate(app, mutation, token);
      expect(response.status, `${mutation.method} ${mutation.url}`).toBe(
        mutation.status,
      );
      if (mutation.method === "PATCH") {
        expect(await store.getWorld(WORLD_ID)).toMatchObject({
          description: "Updated world",
        });
      }
      if (mutation.url.endsWith("/dimensions/import")) {
        expect(await store.getWorld(WORLD_ID)).toMatchObject({
          metadata: { dimensions: DIMENSIONS },
        });
      }
    }
    expect(await store.getWorld("new-world")).toMatchObject({
      name: "New world",
    });
    expect(await store.getWorld(WORLD_ID)).toBeNull();
  }

  it.each([undefined, OWNER_TOKEN])(
    "rejects shared world mutations by anonymous or session-owner callers (%s)",
    async (token) => {
      const { app, store } = await createApp();
      await expectRejectedMutations(app, store, token);
    },
  );

  it("allows the operator to create, patch, import dimensions, and delete", async () => {
    const { app, store } = await createApp();
    await expectAllowedMutations(app, store, OPERATOR_TOKEN);
  });

  it("keeps world list, detail, and dimension export public", async () => {
    const { app, store } = await createApp();
    const world = await store.getWorld(WORLD_ID);
    const listed = await app.request("/api/worlds");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [world] });
    const detail = await app.request(`/api/worlds/${WORLD_ID}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(world);
    const exported = await app.request(
      `/api/worlds/${WORLD_ID}/dimensions/export?format=json`,
    );
    expect(exported.status).toBe(200);
    expect(await exported.json()).toEqual({});
  });

  it.each([
    ["development", "memory", "memory"],
    ["production", "sqlite", "sqlite"],
    ["production", "sqlite", "memory"],
  ] as const)(
    "preserves local writes for %s with context %s and configured %s",
    async (nodeEnv, backend, configuredBackend) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("STORE_BACKEND", configuredBackend);
      const { app, store } = await createApp(backend);
      await expectAllowedMutations(app, store);
    },
  );

  it("uses the injected MemoryStore backend when environment configuration says sqlite", async () => {
    vi.stubEnv("STORE_BACKEND", "sqlite");
    const { app, store } = await createApp();
    await expectRejectedMutations(app, store, OWNER_TOKEN);
  });

  it("fails closed when no operator credential is configured", async () => {
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", undefined);
    const { app, store } = await createApp();
    await expectRejectedMutations(app, store, OWNER_TOKEN);
  });

  it.each([undefined, "server-file", "server-store"])(
    "rejects AI persistence target %s before invoking the LLM or writing files",
    async (saveTarget) => {
      const { app, store, generate } = await createApp();
      const before = await store.listWorlds();
      for (const token of [undefined, OWNER_TOKEN]) {
        const response = await app.request("/api/ai/generate-world", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...authHeaders(token),
          },
          body: JSON.stringify({ concept: "A clockwork city", saveTarget }),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "operator_token_required",
        });
      }
      expect(generate).not.toHaveBeenCalled();
      expect(await store.listWorlds()).toEqual(before);
      expect(await readdir(worldsDir)).toEqual([]);
    },
  );

  it("rejects world installation despite production install opt-in and no operator", async () => {
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", undefined);
    const { app, store } = await createApp();
    const before = await store.listWorlds();
    for (const token of [undefined, OWNER_TOKEN]) {
      const response = await app.request("/api/install/world", {
        method: "POST",
        headers: authHeaders(token),
        body: new FormData(),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "operator_token_required",
      });
    }
    expect(await store.listWorlds()).toEqual(before);
    expect(await readdir(worldsDir)).toEqual([]);
  });

  it("allows the operator through the world-install guard to multipart validation", async () => {
    const { app } = await createApp();
    const response = await app.request("/api/install/world", {
      method: "POST",
      headers: authHeaders(OPERATOR_TOKEN),
      body: new FormData(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'multipart field "file" is required',
    });
    expect(await readdir(worldsDir)).toEqual([]);
  });
});
