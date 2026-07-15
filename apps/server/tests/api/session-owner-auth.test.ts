/**
 * Session owner-token authorization (audit S-02).
 *
 * Tiered model:
 *   - self (default): owner tokens are minted but NOT enforced — local play
 *     stays token-free (the network boundary is the loopback bind).
 *   - demo / commercial: every session-scoped route behind
 *     `resolveSessionParam` / `checkSessionOwner` hard-requires the token;
 *     COVEL_DESKTOP_REST_TOKEN acts as an operator master key.
 *
 * Mounts the REAL route modules, mirroring bootstrap.ts wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { messageRoutes } from "../../src/routes/api/messages.js";
import { traceRoutes } from "../../src/routes/api/traces.js";
import { subscribeRoutes } from "../../src/routes/api/subscribe.js";

const ENV_KEYS = ["DEPLOYMENT_TIER", "COVEL_DESKTOP_REST_TOKEN"] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function createTestApp(store: DataStore, registry: PluginRegistry): Hono {
  const app = new Hono();
  const eventBus = createEventBus(store);
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("eventBus", eventBus);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", messageRoutes);
  app.route("/api/events", subscribeRoutes);
  app.route("/api/traces", traceRoutes);
  return app;
}

interface CreatedSession {
  id: string;
  ownerToken: string;
  metadata?: Record<string, unknown>;
}

async function createSession(app: Hono): Promise<CreatedSession> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CreatedSession;
}

let store: DataStore;
let app: Hono;

beforeEach(() => {
  store = createMemoryStore();
  app = createTestApp(store, createPluginRegistry());
});

describe("self tier (default) — no enforcement, no breakage", () => {
  it("mints an ownerToken on create but never requires it", async () => {
    delete process.env.DEPLOYMENT_TIER;
    const created = await createSession(app);
    expect(typeof created.ownerToken).toBe("string");
    expect(created.ownerToken.length).toBeGreaterThan(10);
    // Only the hash is persisted — the raw token never touches the store.
    const stored = await store.getSession(created.id);
    expect(JSON.stringify(stored)).not.toContain(created.ownerToken);
    expect(stored?.metadata?.ownerTokenHash).toBeTypeOf("string");

    // Token-free access works everywhere (existing local clients unchanged).
    expect((await app.request(`/api/sessions/${created.id}`)).status).toBe(200);
    expect(
      (await app.request(`/api/sessions/${created.id}/messages`)).status,
    ).toBe(200);
    expect((await app.request(`/api/traces/${created.id}`)).status).toBe(200);
    const patch = await app.request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(patch.status).toBe(200);
  });
});

describe("commercial tier — owner token hard-required", () => {
  let created: CreatedSession;

  beforeEach(async () => {
    process.env.DEPLOYMENT_TIER = "commercial";
    created = await createSession(app);
  });

  it("rejects session read without a token (401 session_owner_required)", async () => {
    const res = await app.request(`/api/sessions/${created.id}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("session_owner_required");
  });

  it("rejects a wrong token", async () => {
    const res = await app.request(`/api/sessions/${created.id}`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the owner token via Authorization: Bearer", async () => {
    const res = await app.request(`/api/sessions/${created.id}`, {
      headers: { authorization: `Bearer ${created.ownerToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts the owner token via X-Session-Token", async () => {
    const res = await app.request(`/api/sessions/${created.id}`, {
      headers: { "x-session-token": created.ownerToken },
    });
    expect(res.status).toBe(200);
  });

  it("gates PATCH and DELETE", async () => {
    const patchBody = {
      method: "PATCH" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    };
    expect(
      (await app.request(`/api/sessions/${created.id}`, patchBody)).status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/sessions/${created.id}`, {
          ...patchBody,
          headers: {
            ...patchBody.headers,
            authorization: `Bearer ${created.ownerToken}`,
          },
        })
      ).status,
    ).toBe(200);

    expect(
      (await app.request(`/api/sessions/${created.id}`, { method: "DELETE" }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/sessions/${created.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${created.ownerToken}` },
        })
      ).status,
    ).toBe(200);
  });

  it("gates message history reads", async () => {
    expect(
      (await app.request(`/api/sessions/${created.id}/messages`)).status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/sessions/${created.id}/messages`, {
          headers: { authorization: `Bearer ${created.ownerToken}` },
        })
      ).status,
    ).toBe(200);
  });

  it("gates trace reads (and keeps 404 for unknown sessions)", async () => {
    expect((await app.request(`/api/traces/${created.id}`)).status).toBe(401);
    expect(
      (
        await app.request(`/api/traces/${created.id}`, {
          headers: { authorization: `Bearer ${created.ownerToken}` },
        })
      ).status,
    ).toBe(200);
    const missing = await app.request("/api/traces/no-such-session", {
      headers: { authorization: `Bearer ${created.ownerToken}` },
    });
    expect(missing.status).toBe(404);
  });

  it("gates the SSE subscribe stream; ?session_token= works for EventSource", async () => {
    const denied = await app.request(
      `/api/events/stream?sessionId=${created.id}`,
    );
    expect(denied.status).toBe(401);

    const allowed = await app.request(
      `/api/events/stream?sessionId=${created.id}&session_token=${created.ownerToken}`,
    );
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
  });

  it("fails closed for legacy sessions without a stored hash", async () => {
    await store.createSession({
      id: "legacy-1",
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.request("/api/sessions/legacy-1");
    expect(res.status).toBe(401);
  });

  it("hides the session listing unless the operator token is presented", async () => {
    const anonymous = await app.request("/api/sessions");
    expect(((await anonymous.json()) as { items: unknown[] }).items).toEqual(
      [],
    );

    process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    const operator = await app.request("/api/sessions", {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(
      ((await operator.json()) as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);
  });

  it("accepts the operator master token on session-scoped routes", async () => {
    process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    const res = await app.request(`/api/sessions/${created.id}`, {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(res.status).toBe(200);
  });
});

describe("demo tier — same enforcement as commercial", () => {
  it("requires the owner token", async () => {
    process.env.DEPLOYMENT_TIER = "demo";
    const created = await createSession(app);
    expect((await app.request(`/api/sessions/${created.id}`)).status).toBe(401);
    expect(
      (
        await app.request(`/api/sessions/${created.id}`, {
          headers: { authorization: `Bearer ${created.ownerToken}` },
        })
      ).status,
    ).toBe(200);
  });
});
