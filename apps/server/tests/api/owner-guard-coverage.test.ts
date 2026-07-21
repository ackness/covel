/**
 * Owner-guard coverage for session-scoped routes that receive
 * the session id outside the `:id` route param (query, body, or via an
 * approvalId indirection):
 *
 *   - approvals: pending list / revoke / decision
 *   - media upload (POST /api/media?sessionId=)
 *   - world data-sync: preflight / sync-data / sync-dimensions
 *   - GET /api/ui-specs?sessionId=
 *
 * On demo/commercial these must deny anonymous and other-owner access
 * (401/404); on self they are strict no-ops (historical behavior kept).
 * Mounts the REAL route modules, mirroring bootstrap.ts / app.ts wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import {
  createMemoryStore,
  createMemoryMediaStore,
  type DataStore,
  type MediaStore,
} from "@covel/store";
import { createEventBus } from "@covel/events";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import { sessionRoutes } from "../../src/routes/api/session.js";
import {
  approvalRoutes,
  sessionApprovalRoutes,
} from "../../src/routes/api/approvals.js";
import { mediaRoutes } from "../../src/routes/api/media.js";
import { worldDataSyncRoutes } from "../../src/routes/api/worlds/data-sync.js";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

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

// The AiStack shape misc-api needs — stub the minimum surface for the test.
const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];

const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

interface Harness {
  app: Hono;
  store: DataStore;
  mediaStore: MediaStore;
  registry: PluginRegistry;
  gate: RpcApprovalGate;
}

function createHarness(): Harness {
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  const mediaStore = createMemoryMediaStore();
  const gate = createRpcApprovalGate();
  const eventBus = createEventBus(store);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("mediaStore", mediaStore);
    c.set("eventBus", eventBus);
    c.set("rpcApprovalGate", gate);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", sessionApprovalRoutes);
  app.route("/api/approvals", approvalRoutes);
  app.route("/api/media", mediaRoutes);
  app.route("/api/worlds", worldDataSyncRoutes);
  // Mounted on the root app in app.ts (no bootstrap middleware) — the store
  // travels via closure, mirroring production wiring.
  app.route("/", createMiscApiRoutes(stubAi, registry, store));
  return { app, store, mediaStore, registry, gate };
}

interface CreatedSession {
  id: string;
  ownerToken: string;
}

const OPERATOR = { authorization: "Bearer operator-secret" };

async function createSession(
  app: Hono,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<CreatedSession> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as CreatedSession;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function seedPendingApproval(gate: RpcApprovalGate, sessionId: string): string {
  const ev = gate.evaluate({
    sessionId,
    pluginId: "untrusted",
    action: "do-thing",
    payload: { foo: "bar" },
    trustLevel: "community",
  });
  if (ev.status !== "pending") throw new Error("expected pending");
  return ev.approvalId;
}

describe("commercial tier — owner guard on indirect session-scoped routes", () => {
  let h: Harness;
  let victim: CreatedSession;
  let attacker: CreatedSession;

  beforeEach(async () => {
    process.env.DEPLOYMENT_TIER = "commercial";
    process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
    h = createHarness();
    victim = await createSession(h.app, { worldId: "w1" }, OPERATOR);
    attacker = await createSession(h.app, { worldId: "w1" }, OPERATOR);
  });

  describe("approvals", () => {
    it("denies anonymous and other-owner pending listing", async () => {
      expect(
        (await h.app.request(`/api/sessions/${victim.id}/approvals`)).status,
      ).toBe(401);
      expect(
        (
          await h.app.request(`/api/sessions/${victim.id}/approvals`, {
            headers: bearer(attacker.ownerToken),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await h.app.request(`/api/sessions/${victim.id}/approvals`, {
            headers: bearer(victim.ownerToken),
          })
        ).status,
      ).toBe(200);
    });

    it("denies anonymous revoke", async () => {
      expect(
        (
          await h.app.request(`/api/sessions/${victim.id}/approvals`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await h.app.request(`/api/sessions/${victim.id}/approvals`, {
            method: "DELETE",
            headers: bearer(victim.ownerToken),
          })
        ).status,
      ).toBe(200);
    });

    it("resolves approvalId → session and denies non-owner decisions without consuming the pending entry", async () => {
      const approvalId = seedPendingApproval(h.gate, victim.id);
      const decide = (headers: Record<string, string> = {}) =>
        h.app.request(`/api/approvals/${approvalId}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ decision: "allow", scope: "session" }),
        });

      expect((await decide()).status).toBe(401);
      expect((await decide(bearer(attacker.ownerToken))).status).toBe(401);
      // The denied attempts must not have consumed the pending entry.
      expect(h.gate.getPending(approvalId)).toBeDefined();
      // Community code is process-global, so its approval requires the
      // operator master credential (which also satisfies the owner guard).
      expect((await decide(OPERATOR)).status).toBe(200);
    });
  });

  describe("media upload", () => {
    const upload = (app: Hono, sessionId: string, headers = {}) =>
      app.request(`/api/media?sessionId=${sessionId}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...headers },
        body: IMG,
      });

    it("denies anonymous / other-owner uploads that would record ownership", async () => {
      expect((await upload(h.app, victim.id)).status).toBe(401);
      expect(
        (await upload(h.app, victim.id, bearer(attacker.ownerToken))).status,
      ).toBe(401);
      expect(
        (await upload(h.app, victim.id, bearer(victim.ownerToken))).status,
      ).toBe(200);
    });

    it("fails closed (404) for unknown session ids", async () => {
      expect((await upload(h.app, "no-such-session")).status).toBe(404);
    });
  });

  describe("world data-sync", () => {
    const post = (path: string, body: unknown, headers = {}) =>
      h.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    it("denies anonymous / other-owner preflight for an existing session", async () => {
      const path = "/api/worlds/w1/world-data/preflight";
      const body = { sessionId: victim.id };
      expect((await post(path, body)).status).toBe(401);
      expect((await post(path, body, bearer(attacker.ownerToken))).status).toBe(
        401,
      );
      expect((await post(path, body, bearer(victim.ownerToken))).status).toBe(
        200,
      );
    });

    it("denies anonymous / other-owner sync-data", async () => {
      const path = "/api/worlds/w1/sync-data";
      const body = { sessionId: victim.id, dryRun: true };
      expect((await post(path, body)).status).toBe(401);
      expect((await post(path, body, bearer(attacker.ownerToken))).status).toBe(
        401,
      );
      expect(
        (await post(path, body, bearer(victim.ownerToken))).status,
      ).not.toBe(401);
    });

    it("denies anonymous sync-dimensions before any write", async () => {
      await h.store.upsertWorld({
        id: "w1",
        name: "World 1",
        description: "",
        createdAt: new Date().toISOString(),
        metadata: { dimensions: { geography: "hills" } },
      });
      const path = "/api/worlds/w1/sync-dimensions";
      const body = { sessionId: victim.id };
      expect((await post(path, body)).status).toBe(401);
      // Owner passes the guard; 422 = no world-data-provider plugin active,
      // proving the request advanced past authorization.
      expect((await post(path, body, bearer(victim.ownerToken))).status).toBe(
        422,
      );
    });
  });

  describe("GET /api/ui-specs", () => {
    it("denies anonymous / other-owner session-scoped reads (which also write plugin_data)", async () => {
      const path = `/api/ui-specs?sessionId=${victim.id}`;
      expect((await h.app.request(path)).status).toBe(401);
      expect(
        (await h.app.request(path, { headers: bearer(attacker.ownerToken) }))
          .status,
      ).toBe(401);
      expect(
        (await h.app.request(path, { headers: bearer(victim.ownerToken) }))
          .status,
      ).toBe(200);
    });

    it("keeps the session-less global listing open", async () => {
      expect((await h.app.request("/api/ui-specs")).status).toBe(200);
    });
  });
});

describe("self tier (default) — guards are strict no-ops", () => {
  let h: Harness;

  beforeEach(() => {
    delete process.env.DEPLOYMENT_TIER;
    h = createHarness();
  });

  it("allows anonymous session creation (gate is hosted-only)", async () => {
    const created = await createSession(h.app);
    expect(typeof created.ownerToken).toBe("string");
  });

  it("keeps approvals listing token-free, even for ids with no session row", async () => {
    const res = await h.app.request("/api/sessions/s1/approvals");
    expect(res.status).toBe(200);
  });

  it("keeps media upload token-free with no session-existence requirement", async () => {
    const res = await h.app.request("/api/media?sessionId=s1", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMG,
    });
    expect(res.status).toBe(200);
  });

  it("keeps ui-specs token-free", async () => {
    const created = await createSession(h.app);
    expect(
      (await h.app.request(`/api/ui-specs?sessionId=${created.id}`)).status,
    ).toBe(200);
  });
});
