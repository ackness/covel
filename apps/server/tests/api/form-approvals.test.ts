import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { createBootstrapPluginRpc } from "../../src/routes/api/bootstrap/plugin-rpc-wiring.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { approvalRoutes } from "../../src/routes/api/approvals.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";
import { settledSubmission } from "../helpers/submit-interaction.js";

describe("form provider authorization", () => {
  const sessionId = "forms-session";
  const providers = ["first", "second", "third"];
  let store: ReturnType<typeof createMemoryStore>;
  let app: Hono;
  let rpc: ReturnType<typeof createBootstrapPluginRpc>;
  let plugins: ReturnType<typeof createPluginRegistry>;
  const validate = vi.fn(
    () => undefined as readonly { message: string }[] | undefined,
  );
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
  const submit = async (body = payload, headers: Record<string, string> = {}) =>
    settledSubmission(
      await app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          sessionId,
          type: "submit_interaction",
          payload: body,
        }),
      }),
    );

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    validate.mockReset().mockReturnValue(undefined);
    store = createMemoryStore();
    await store.createSession({
      id: sessionId,
      status: "active",
      locale: "zh-CN",
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
    plugins = createPluginRegistry();
    rpc = createBootstrapPluginRpc();
    for (const [order, id] of providers.entries()) {
      // A manual runtime: the follow-up turn runs nothing and asks for no
      // runtime grant, so every approval here is the form's own.
      const { stage: _stage, ...fake } = makeFakeLoadedRuntime({
        name: id,
      }).manifest;
      const loaded = {
        ...makeFakeLoadedRuntime({ name: id }),
        manifest: { ...fake, trigger: { type: "manual" as const } },
      };
      const parsed = {
        runtime: { type: loaded.manifest.runtimeType ?? ("agent" as const) },
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
        packageManifest: parsePluginMd(
          `---\n${JSON.stringify({ id, kind: "plugin", description: id, contributes: { forms: ["check"] } })}\n---\n`,
          "PLUGIN.md",
        ),
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
    const eventBus = createEventBus(store);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("eventBus", eventBus);
      c.set("llmAdapter", {
        generate: async () => {
          throw new Error("No runtime runs in this turn");
        },
      });
      c.set("loadRuntimeFn", async () => undefined);
      c.set("resolveModel", () => undefined);
      c.set("pluginRegistry", plugins);
      c.set("rpcRegistry", rpc.rpcRegistry);
      c.set("rpcExecutor", rpc.rpcExecutor);
      c.set("rpcApprovalGate", rpc.rpcApprovalGate);
      c.set("sessionLock", lock);
      await next();
    });
    app.route("/api/actions", actionRoutes);
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
      .mockReturnValueOnce([{ message: "Rejected last form" }]);
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

  it.each(["builtin", "community"] as const)(
    "rejects an undeclared %s validator without asking for approval or saving input",
    async (source) => {
      plugins.register({ ...plugins.get("first")!, source });
      await store.appendTurnMessage({
        id: "message-undeclared",
        sessionId,
        turnId: "forms",
        sourceType: "runtime",
        sourcePluginId: "first",
        role: "assistant",
        content: "",
        order: 3,
        createdAt: now,
        pendingInput: [
          {
            interactionId: "undeclared",
            type: "form",
            fields: [{ name: "value", type: "text" }],
            validation: { name: "characterName" },
          },
        ],
      });
      const response = await submit({
        ...payload,
        submissions: [
          { ...payload.submissions[0]!, interactionId: "undeclared" },
        ],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "form_validator_undeclared",
        error: expect.stringContaining("regenerate the form"),
        details: { pluginId: "first", validator: "characterName" },
      });
      expect(rpc.rpcApprovalGate.listAllPendingForSession(sessionId)).toEqual(
        [],
      );
      expect(validate).not.toHaveBeenCalled();
      expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    },
  );

  it("rejects a disabled provider before requesting grants for the batch", async () => {
    await store.updateSession(sessionId, {
      activePlugins: ["first", "second"],
    });
    expect((await submit()).status).toBe(400);
    expect(rpc.rpcApprovalGate.listAllPendingForSession(sessionId)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
  });

  it("requires the hosted operator before a community form validator loads", async () => {
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
