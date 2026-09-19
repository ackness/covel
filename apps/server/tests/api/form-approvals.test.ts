import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createBootstrapPluginRpc } from "../../src/routes/api/bootstrap/plugin-rpc-wiring.js";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { approvalRoutes } from "../../src/routes/api/approvals.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

describe("form provider authorization", () => {
  const sessionId = "forms-session";
  const providers = ["first", "second", "third"];
  let store: ReturnType<typeof createMemoryStore>;
  let app: Hono;
  let rpc: ReturnType<typeof createBootstrapPluginRpc>;
  const validate = vi.fn(() => undefined as string | undefined);
  const now = "2026-01-01T00:00:00.000Z";
  const payload = {
    turnId: "forms",
    submissions: providers.map((id) => ({
      interactionId: id,
      type: "form",
      values: { value: "ok" },
      pluginId: "forged-client-provider",
    })),
  };
  const submit = (body = payload, headers: Record<string, string> = {}) =>
    app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "submit-form",
        payload: body,
      }),
    });

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    validate.mockReset().mockReturnValue(undefined);
    store = createMemoryStore();
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      completedPlayerTurns: 0,
      activePlugins: providers,
      metadata: {
        approvalScopeNonce: "synthetic-scope",
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const plugins = createPluginRegistry();
    rpc = createBootstrapPluginRpc();
    for (const [order, id] of providers.entries()) {
      const loaded = makeFakeLoadedRuntime({ name: id });
      const parsed = {
        manifest: loaded.manifest,
        promptTemplate: loaded.promptTemplate,
        rawFrontmatter: {},
      };
      plugins.register({
        id,
        source: "community",
        status: "registered",
        summary: {
          id,
          name: id,
          description: "",
          pluginType: "plugin",
          runtimeCount: 1,
        },
        manifest: parsed,
        manifests: [parsed],
        loadedRuntimes: new Map([[id, loaded]]),
      });
      rpc.rpcRegistry.registerFormValidator(id, "check", async () =>
        validate(),
      );
      await store.appendTurnMessage({
        id: `message-${id}`,
        sessionId,
        turnId: "forms",
        sourceType: "runtime",
        sourcePluginId: id,
        role: "assistant",
        content: "",
        order,
        createdAt: now,
        pendingInput: [
          {
            interactionId: id,
            type: "form",
            fields: [{ name: "value", type: "text" }],
            validation: { name: "check" },
          },
        ],
      });
    }
    const lock = createInProcessSessionLock();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", plugins);
      c.set("rpcRegistry", rpc.rpcRegistry);
      c.set("rpcExecutor", rpc.rpcExecutor);
      c.set("rpcApprovalGate", rpc.rpcApprovalGate);
      c.set("sessionLock", lock);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    app.route("/api/approvals", approvalRoutes);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await store.close();
  });

  it("authorizes persisted providers individually before validating or saving the batch", async () => {
    for (const pluginId of providers) {
      const response = await submit();
      expect(response.status, await response.clone().text()).toBe(202);
      const pending = await response.json();
      expect(pending.pending).toMatchObject({
        pluginId,
        action: "covel:plugin-server-code",
      });
      expect(validate).not.toHaveBeenCalled();
      expect(await store.listPlayerInputs(sessionId)).toEqual([]);
      expect(
        (
          await app.request(`/api/approvals/${pending.approvalId}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow", scope: "session" }),
          })
        ).status,
      ).toBe(200);
    }
    validate
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("Rejected last form");
    expect((await submit()).status).toBe(400);
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    expect((await submit()).status).toBe(200);
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(3);
  });

  it("does not derive providers from client-supplied form metadata", async () => {
    const response = await submit({
      ...payload,
      submissions: [{ ...payload.submissions[0]!, interactionId: "unknown" }],
    });
    expect(response.status).toBe(400);
    expect(rpc.rpcApprovalGate.listAllPendingForSession(sessionId)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects a disabled provider before requesting grants for the batch", async () => {
    await store.updateSession(sessionId, {
      activePlugins: ["first", "second"],
    });
    expect((await submit()).status).toBe(400);
    expect(rpc.rpcApprovalGate.listAllPendingForSession(sessionId)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
  });

  it("requires the hosted operator even though submit-form is a framework action", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "commercial");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-operator");
    await store.updateSession(sessionId, {
      metadata: {
        approvalScopeNonce: "synthetic-scope",
        ownerTokenHash: hashSessionOwnerToken("synthetic-owner"),
      },
    });
    const denied = await submit(payload, {
      "X-Session-Token": "synthetic-owner",
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({
      code: "operator_token_required",
    });
    expect(rpc.rpcApprovalGate.listAllPendingForSession(sessionId)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    expect(
      (
        await submit(payload, {
          "X-Session-Token": "synthetic-owner",
          Authorization: "Bearer synthetic-operator",
        })
      ).status,
    ).toBe(202);
  });
});
