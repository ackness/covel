/**
 * End-to-end approval flow tests.
 *
 * Covers:
 *   - community-trust dispatch → 202 approval-required
 *   - per-session pending approval listing
 *   - POST decision → allow once → next dispatch goes through
 *   - decision deny → next dispatch still pending
 *   - session-scope grant → repeated dispatches all auto-allowed
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  type PluginRpcRegistry,
  type RpcExecutor,
} from "@covel/runtime";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  createRpcApprovalGate,
  type RpcApprovalGate,
} from "@covel/approval";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import {
  approvalRoutes,
  sessionApprovalRoutes,
} from "../../src/routes/api/approvals.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import {
  SESSION_DELETION_PENDING_KEY,
  sessionApprovalScope,
} from "../../src/routes/api/session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
  };
};

function setup(
  store: DataStore = createMemoryStore(),
  gate: RpcApprovalGate = createRpcApprovalGate(),
): {
  app: Hono;
  store: DataStore;
  registry: PluginRpcRegistry;
  gate: RpcApprovalGate;
} {
  const registry = createPluginRpcRegistry();
  // Community-trust action that just echoes payload.
  registry.registerPluginHandler(
    "untrusted",
    "do-thing",
    async (payload) => ({ ranWith: payload }),
    { description: "Run the thing" },
    "community",
  );
  const executor = createRpcExecutor({ registry });
  const sessionLock = createInProcessSessionLock();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("rpcExecutor", executor);
    c.set("rpcRegistry", registry);
    c.set("rpcApprovalGate", gate);
    c.set("sessionLock", sessionLock);
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  app.route("/api/sessions", sessionApprovalRoutes);
  app.route("/api/approvals", approvalRoutes);
  return { app, store, registry, gate };
}

async function seedSession(
  store: DataStore,
  id = "sess-approval-1",
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: "cloudmere",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

async function dispatchRpc(app: Hono, sessionId: string): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginId: "untrusted",
      action: "do-thing",
      payload: { foo: "bar" },
    }),
  });
}

/**
 * Community server code is two-phase: a `covel:plugin-server-code` grant to
 * import the plugin's handler module, then the precise action grant. Clears
 * phase 1 with a session-scoped grant and returns the phase-2 response.
 */
async function clearServerCodePhase(
  app: Hono,
  sessionId: string,
): Promise<Response> {
  const first = await dispatchRpc(app, sessionId);
  const { approvalId } = (await first.json()) as { approvalId: string };
  await app.request(`/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "allow", scope: "session" }),
  });
  return dispatchRpc(app, sessionId);
}

describe("Plugin RPC approval flow", () => {
  let app: Hono;
  let store: DataStore;
  let gate: RpcApprovalGate;

  beforeEach(async () => {
    ({ app, store, gate } = setup());
    await seedSession(store);
  });

  it("community-trust dispatch returns 202 with approval-required envelope", async () => {
    const res = await dispatchRpc(app, "sess-approval-1");
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      approvalId: string;
      pending: { pluginId: string; action: string; description?: string };
    };
    expect(body.status).toBe("approval-required");
    expect(body.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pending.pluginId).toBe("untrusted");
    // Phase 1: importing the community handler module is itself server code.
    expect(body.pending.action).toBe("covel:plugin-server-code");

    // Phase 2 only after the server-code grant exists.
    const second = await clearServerCodePhase(app, "sess-approval-1");
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as {
      pending: { action: string; description?: string };
    };
    expect(secondBody.pending.action).toBe("do-thing");
    expect(secondBody.pending.description).toBe("Run the thing");
  });

  it("GET /api/sessions/:id/approvals lists session pending entries", async () => {
    await dispatchRpc(app, "sess-approval-1");
    await dispatchRpc(app, "sess-approval-1");

    const res = await app.request("/api/sessions/sess-approval-1/approvals");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: ReadonlyArray<unknown> };
    expect(body.pending).toHaveLength(1);
  });

  it("decision allow + scope=once unblocks exactly one follow-up dispatch", async () => {
    const initial = await clearServerCodePhase(app, "sess-approval-1");
    const { approvalId } = (await initial.json()) as { approvalId: string };

    // Approve once.
    const decideRes = await app.request(
      `/api/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "once" }),
      },
    );
    expect(decideRes.status).toBe(200);

    // Re-dispatch — should run.
    const second = await dispatchRpc(app, "sess-approval-1");
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      status: string;
      result: { ranWith: unknown };
    };
    expect(body.status).toBe("ok");
    expect(body.result.ranWith).toEqual({ foo: "bar" });

    // A third dispatch should be back to pending — once-grant is consumed.
    const third = await dispatchRpc(app, "sess-approval-1");
    expect(third.status).toBe(202);
  });

  it("decision allow + scope=session caches for the rest of the session", async () => {
    const initial = await clearServerCodePhase(app, "sess-approval-1");
    const { approvalId } = (await initial.json()) as { approvalId: string };

    await app.request(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "session" }),
    });

    // Several follow-ups should all run.
    for (let i = 0; i < 3; i++) {
      const res = await dispatchRpc(app, "sess-approval-1");
      expect(res.status).toBe(200);
    }
  });

  it("decision deny does not unblock further dispatches", async () => {
    const initial = await dispatchRpc(app, "sess-approval-1");
    const { approvalId } = (await initial.json()) as { approvalId: string };

    await app.request(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });

    const second = await dispatchRpc(app, "sess-approval-1");
    expect(second.status).toBe(202); // fresh approvalId, still pending
  });

  it("POST decision with invalid body returns 400", async () => {
    const initial = await dispatchRpc(app, "sess-approval-1");
    const { approvalId } = (await initial.json()) as { approvalId: string };

    const res = await app.request(`/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires session scope for approvals that unlock runtime code", async () => {
    const sessionRecord = await store.getSession("sess-approval-1");
    if (!sessionRecord) throw new Error("expected session");
    const pending = gate.evaluate({
      sessionId: "sess-approval-1",
      sessionScope: sessionApprovalScope(sessionRecord, "untrusted"),
      pluginId: "untrusted",
      action: "runtime:agent",
      payload: {},
      trustLevel: "community",
    });
    if (pending.status !== "pending") throw new Error("expected pending");

    const once = await app.request(
      `/api/approvals/${pending.approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "once" }),
      },
    );
    expect(once.status).toBe(400);
    expect(gate.getPending(pending.approvalId)).toBeDefined();

    const session = await app.request(
      `/api/approvals/${pending.approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      },
    );
    expect(session.status).toBe(200);
  });

  it("POST decision with unknown approvalId returns 404", async () => {
    const res = await app.request("/api/approvals/nonexistent/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(404);
  });

  it("invalidates another Pod's stale grants and pending decisions after revoke", async () => {
    const sharedStore = createMemoryStore();
    const podA = setup(sharedStore);
    const podB = setup(sharedStore);
    await seedSession(sharedStore, "shared-session");

    const serverCode = await dispatchRpc(podA.app, "shared-session");
    expect(serverCode.status).toBe(202);
    const serverCodePending = (await serverCode.json()) as {
      approvalId: string;
    };
    expect(
      (
        await podA.app.request(
          `/api/approvals/${serverCodePending.approvalId}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "allow", scope: "session" }),
          },
        )
      ).status,
    ).toBe(200);

    // The next request has cleared phase 1 and is waiting on the exact action.
    const action = await dispatchRpc(podA.app, "shared-session");
    expect(action.status).toBe(202);
    const staleActionPending = (await action.json()) as {
      approvalId: string;
      pending: { action: string };
    };
    expect(staleActionPending.pending.action).toBe("do-thing");

    // Pod B has no local grants to clear. Persisting a new plugin revision is
    // what invalidates Pod A's cache without an in-process broadcast.
    const revoke = await podB.app.request(
      "/api/sessions/shared-session/approvals?pluginId=untrusted",
      { method: "DELETE" },
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ ok: true, cleared: 0 });

    const staleDecision = await podA.app.request(
      `/api/approvals/${staleActionPending.approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      },
    );
    expect(staleDecision.status).toBe(409);
    expect(await staleDecision.json()).toMatchObject({
      code: "approval_scope_changed",
    });

    const retried = await dispatchRpc(podA.app, "shared-session");
    expect(retried.status).toBe(202);
    const retriedBody = (await retried.json()) as {
      pending: { action: string };
    };
    expect(retriedBody.pending.action).toBe(COMMUNITY_SERVER_CODE_ACTION);
  });

  // Stage 4 regression: when bootstrap wires the activator, an `allow`
  // decision must invoke it for the approved pluginId. `deny` must not.
  // We stub the activator into the context and assert call shape.
  describe("community plugin entry activation hook", () => {
    function setupWithActivator(options?: {
      sessionLock?: SessionLock;
      activate?: (pluginId: string) => Promise<void>;
    }): {
      app: Hono;
      store: DataStore;
      gate: RpcApprovalGate;
      activatorCalls: string[];
    } {
      const store = createMemoryStore();
      const registry = createPluginRpcRegistry();
      registry.registerPluginHandler(
        "untrusted",
        "do-thing",
        async () => ({ ok: true }),
        { description: "Run the thing" },
        "community",
      );
      const executor = createRpcExecutor({ registry });
      const gate = createRpcApprovalGate();
      const sessionLock = options?.sessionLock ?? createInProcessSessionLock();
      const activatorCalls: string[] = [];
      const app = new Hono<
        Env & {
          Variables: {
            activatePluginServerCode?: (id: string) => Promise<void>;
          };
        }
      >();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("rpcExecutor", executor);
        c.set("rpcRegistry", registry);
        c.set("rpcApprovalGate", gate);
        c.set("sessionLock", sessionLock);
        c.set("activatePluginServerCode", async (pluginId: string) => {
          activatorCalls.push(pluginId);
          await options?.activate?.(pluginId);
        });
        await next();
      });
      app.route("/api/sessions", pluginRpcRoutes);
      app.route("/api/sessions", sessionApprovalRoutes);
      app.route("/api/approvals", approvalRoutes);
      return { app, store, gate, activatorCalls };
    }

    it("calls activatePluginServerCode(pluginId) on allow decision", async () => {
      const { app, store, activatorCalls } = setupWithActivator();
      await seedSession(store);

      const initial = await dispatchRpc(app, "sess-approval-1");
      const { approvalId } = (await initial.json()) as { approvalId: string };

      await app.request(`/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      });

      expect(activatorCalls).toEqual(["untrusted"]);
    });

    it("releases the session lock before running community entry code", async () => {
      let held = false;
      const strictLock: SessionLock = {
        async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
          if (held) throw new Error("nested lifecycle lock");
          held = true;
          try {
            return await fn();
          } finally {
            held = false;
          }
        },
        async withLocks<T>(
          _keys: readonly string[],
          fn: () => Promise<T>,
        ): Promise<T> {
          return this.withLock("batch", fn);
        },
      };
      const { app, store } = setupWithActivator({
        sessionLock: strictLock,
        activate: async () => {
          expect(held).toBe(false);
        },
      });
      await seedSession(store);

      const initial = await dispatchRpc(app, "sess-approval-1");
      const { approvalId } = (await initial.json()) as { approvalId: string };
      const res = await app.request(`/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      });

      expect(res.status).toBe(200);
    });

    it("does NOT call activator on deny", async () => {
      const { app, store, activatorCalls } = setupWithActivator();
      await seedSession(store);

      const initial = await dispatchRpc(app, "sess-approval-1");
      const { approvalId } = (await initial.json()) as { approvalId: string };

      await app.request(`/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      });

      expect(activatorCalls).toEqual([]);
    });

    it("survives activator throwing — decision still committed", async () => {
      const store = createMemoryStore();
      const registry = createPluginRpcRegistry();
      registry.registerPluginHandler(
        "untrusted",
        "do-thing",
        async () => ({ ok: true }),
        { description: "Run the thing" },
        "community",
      );
      const executor = createRpcExecutor({ registry });
      const gate = createRpcApprovalGate();
      const sessionLock = createInProcessSessionLock();
      const app = new Hono<
        Env & {
          Variables: {
            activatePluginServerCode?: (id: string) => Promise<void>;
          };
        }
      >();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("rpcExecutor", executor);
        c.set("rpcRegistry", registry);
        c.set("rpcApprovalGate", gate);
        c.set("sessionLock", sessionLock);
        c.set("activatePluginServerCode", async () => {
          throw new Error("boom");
        });
        await next();
      });
      app.route("/api/sessions", pluginRpcRoutes);
      app.route("/api/sessions", sessionApprovalRoutes);
      app.route("/api/approvals", approvalRoutes);
      await seedSession(store);

      const initial = await dispatchRpc(app, "sess-approval-1");
      const { approvalId } = (await initial.json()) as { approvalId: string };

      const res = await app.request(`/api/approvals/${approvalId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      });
      // Decision succeeds even though activation threw — the user's intent
      // is recorded and the next plugin-rpc retries activation just-in-time.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe("DELETE /api/sessions/:id/approvals (revoke)", () => {
    function grant(
      gate: RpcApprovalGate,
      sessionId: string,
      pluginId: string,
    ): void {
      const ev = gate.evaluate({
        sessionId,
        sessionScope: "revoke-test-scope",
        pluginId,
        action: "do-thing",
        payload: null,
        trustLevel: "community",
      });
      if (ev.status !== "pending") throw new Error("unreachable");
      gate.decide(
        {
          approvalId: ev.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        "revoke-test-scope",
      );
    }
    const allowed = (
      gate: RpcApprovalGate,
      sessionId: string,
      pluginId: string,
    ): boolean =>
      gate.evaluate({
        sessionId,
        sessionScope: "revoke-test-scope",
        pluginId,
        action: "do-thing",
        payload: null,
        trustLevel: "community",
      }).status === "allow";

    it("revokes all session grants and returns the cleared count", async () => {
      const { app, gate, store } = setup();
      await seedSession(store, "s1");
      grant(gate, "s1", "untrusted");
      grant(gate, "s1", "other");
      expect(allowed(gate, "s1", "untrusted")).toBe(true);

      const res = await app.request("/api/sessions/s1/approvals", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; cleared: number };
      expect(body).toMatchObject({ ok: true, cleared: 2 });
      expect(allowed(gate, "s1", "untrusted")).toBe(false);
    });

    it("scopes the revoke to one plugin via ?pluginId=", async () => {
      const { app, gate, store } = setup();
      await seedSession(store, "s1");
      grant(gate, "s1", "untrusted");
      grant(gate, "s1", "other");

      const res = await app.request(
        "/api/sessions/s1/approvals?pluginId=untrusted",
        { method: "DELETE" },
      );

      const body = (await res.json()) as { cleared: number };
      expect(body.cleared).toBe(1);
      expect(allowed(gate, "s1", "untrusted")).toBe(false);
      expect(allowed(gate, "s1", "other")).toBe(true);
    });

    it("does not revoke grants after session deletion has started", async () => {
      const { app, gate, store } = setup();
      await seedSession(store, "s1");
      await store.updateSession("s1", {
        metadata: { [SESSION_DELETION_PENDING_KEY]: "delete-1" },
      });
      grant(gate, "s1", "untrusted");

      const res = await app.request("/api/sessions/s1/approvals", {
        method: "DELETE",
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "session_deleting" });
      expect(allowed(gate, "s1", "untrusted")).toBe(true);
    });
  });
});
