/**
 * Session owner-token authorization.
 *
 * Tiered model:
 *   - self (default): owner tokens are minted but NOT enforced in dev/desktop.
 *   - self + production MemoryStore: browser-private mode enforces owner tokens
 *     while keeping anonymous session creation open.
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
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  hashSessionOwnerToken,
  verifyResolvedSessionRead,
} from "../../src/routes/api/session/session-guard.js";

const ENV_KEYS = [
  "DEPLOYMENT_TIER",
  "COVEL_DESKTOP_REST_TOKEN",
  "NODE_ENV",
] as const;
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
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("storeBackend", "memory");
    c.set("pluginRegistry", registry);
    c.set("eventBus", eventBus);
    c.set("sessionLock", sessionLock);
    await next();
    const staleRead = await verifyResolvedSessionRead(c);
    if (staleRead) c.res = staleRead;
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

async function createSession(
  app: Hono,
  headers: Record<string, string> = {},
): Promise<CreatedSession> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CreatedSession;
}

const OPERATOR = { authorization: "Bearer operator-secret" };

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
    expect(stored?.metadata?.approvalScopeNonce).toBeTypeOf("string");
    expect(created.metadata?.ownerTokenHash).toBeUndefined();
    expect(created.metadata?.approvalScopeNonce).toBeUndefined();

    // Token-free access works everywhere (existing local clients unchanged).
    const getSession = await app.request(`/api/sessions/${created.id}`);
    expect(getSession.status).toBe(200);
    const sessionBody = (await getSession.json()) as CreatedSession;
    expect(sessionBody.metadata?.ownerTokenHash).toBeUndefined();
    expect(sessionBody.metadata?.approvalScopeNonce).toBeUndefined();
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

describe("browser-private tier — anonymous create, owner-only access", () => {
  it("enforces owner tokens for production MemoryStore mirrors", async () => {
    delete process.env.DEPLOYMENT_TIER;
    process.env.NODE_ENV = "production";

    const created = await createSession(app);
    expect((await app.request(`/api/sessions/${created.id}`)).status).toBe(401);
    expect(
      (
        await app.request(`/api/sessions/${created.id}`, {
          headers: { "x-session-token": created.ownerToken },
        })
      ).status,
    ).toBe(200);
  });
});

describe("commercial tier — owner token hard-required", () => {
  let created: CreatedSession;

  beforeEach(async () => {
    process.env.DEPLOYMENT_TIER = "commercial";
    // Session creation is operator-gated on hosted tiers.
    process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    created = await createSession(app, OPERATOR);
  });

  it("rejects anonymous session creation (operator gate)", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("operator_token_required");
  });

  it("rejects session creation with a non-operator token", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-the-operator",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
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

  it("rejects data read from a same-id replacement after owner authorization", async () => {
    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead = (): void => undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const racingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property !== "listMessages") {
          return Reflect.get(target, property, receiver);
        }
        return async (sessionId: string) => {
          markReadStarted();
          await readReleased;
          return store.listMessages(sessionId);
        };
      },
    }) as DataStore;
    const racingApp = createTestApp(racingStore, createPluginRegistry());

    const responsePromise = racingApp.request(
      `/api/sessions/${created.id}/messages`,
      { headers: { authorization: `Bearer ${created.ownerToken}` } },
    );
    await readStarted;
    await store.deleteSession(created.id);
    const now = new Date().toISOString();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      id: created.id,
      status: "active",
      completedPlayerTurns: 0,

      activePlugins: [],
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        ownerTokenHash: hashSessionOwnerToken("new-owner"),
      },
      createdAt: now,
      updatedAt: now,
    });
    await store.addMessage({
      id: "new-incarnation-secret",
      sessionId: created.id,
      role: "assistant",
      content: "must not cross the old owner check",
      createdAt: now,
    });
    releaseRead();

    const response = await responsePromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_incarnation_changed",
    });
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
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "legacy-1",
      status: "active",
      completedPlayerTurns: 0,

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

    const operator = await app.request("/api/sessions", {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(
      ((await operator.json()) as { items: unknown[] }).items.length,
    ).toBeGreaterThan(0);
  });

  it("accepts the operator master token on session-scoped routes", async () => {
    const res = await app.request(`/api/sessions/${created.id}`, {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(res.status).toBe(200);
  });
});

describe("demo tier — same enforcement as commercial", () => {
  it("requires the owner token", async () => {
    process.env.DEPLOYMENT_TIER = "demo";
    process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    const created = await createSession(app, OPERATOR);
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
