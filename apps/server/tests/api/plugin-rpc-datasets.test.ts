import { readRuntimeEnv } from "@covel/shared";
import { mintSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";
import {
  hostProfileMiddleware,
  resolveHostProfile,
} from "../../src/host-profile.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginRpcRegistry, createRpcExecutor } from "@covel/runtime";
import { createRpcApprovalGate } from "@covel/approval";
import { MAX_PLUGIN_DATA_VALUE_BYTES } from "@covel/shared";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { pluginDataRoutes } from "../../src/routes/api/plugin-data.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";
import { datasetWriteFixture } from "../helpers/dataset-write-fixture.js";

afterEach(() => vi.restoreAllMocks());
let address = 1;

async function setup(source: "builtin" | "community" = "builtin") {
  const fixture = await datasetWriteFixture();
  const store = createMemoryStore();
  await store.createSession({
    ...fixture.session(),
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
  });
  const entry = fixture.registry.get("probe")!;
  fixture.registry.register({
    ...entry,
    source,
    packageManifest: {
      ...entry.packageManifest!,
      manifest: {
        ...entry.packageManifest!.manifest,
        commands: [
          { name: "write", action: "write", description: "Write a note" },
        ],
      },
    },
  });
  const registry = createPluginRpcRegistry();
  registry.registerFrameworkDefault("echo", async (payload) => payload);
  const gate = createRpcApprovalGate();
  const lock = createInProcessSessionLock();
  const app = new Hono();
  app.onError(makeErrorHandler("[dataset-test]", false));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", fixture.registry);
    c.set("rpcRegistry", registry);
    c.set("rpcExecutor", createRpcExecutor({ registry }));
    c.set("rpcApprovalGate", gate);
    c.set("sessionLock", lock);
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  app.route("/api/sessions", pluginDataRoutes);
  const client = `10.21.0.${address++}`;
  const request = (body: unknown) =>
    app.request(
      `/api/sessions/${fixture.options.sessionId}/plugin-rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: client } } },
    );
  const approvedRequest = async (body: unknown) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(body);
      if (response.status !== 202) return response;
      const pending = (await response.json()) as { approvalId: string };
      const session = await store.getSession(fixture.options.sessionId);
      await gate.decide(
        {
          approvalId: pending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: fixture.options.now,
        },
        sessionApprovalScope(session!, "probe"),
      );
    }
    throw new Error("Approval did not settle");
  };
  return {
    ...fixture,
    app,
    store,
    registry,
    approvedRequest,
    request,
    close: async () => {
      await store.close();
      await fixture.cleanup();
    },
  };
}

describe("action and command dataset admission", () => {
  it.each(["builtin", "community"] as const)(
    "enforces runtime-less %s package policies after approval",
    async (source) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const f = await setup(source);
      try {
        f.registry.registerPluginHandler(
          "probe",
          "write",
          async (payload, ctx) => {
            await ctx.store.setPluginData!({
              namespace: "notes",
              key: "Exact Key",
              value: payload,
            });
            return { saved: true };
          },
          {},
          source,
        );
        const action = (value: unknown) => ({
          kind: "action",
          pluginId: "probe",
          action: "write",
          payload: value,
        });
        const refused = await f.approvedRequest(action({ id: "a", text: 5 }));
        expect(refused.status).toBe(500);
        expect(await refused.json()).toEqual({
          error: "Internal server error",
        });
        expect(await f.rows(f.store)).toEqual([]);
        const valid = await f.approvedRequest(
          action({ id: "a", text: "valid" }),
        );
        expect(valid.status).toBe(200);
        expect((await f.rows(f.store))[0]?.key).toBe("Exact Key");
        // The package command resolves its handler through the same scoped view.
        f.policy(["inc"]);
        const command = await f.approvedRequest({
          kind: "command",
          commandId: "probe:write",
          input: "/write",
        });
        expect(command.status).toBe(500);
        expect((await f.rows(f.store))[0]?.value).toEqual({
          id: "a",
          text: "valid",
        });
        expect(
          (await f.store.getSession(f.options.sessionId))?.completedPlayerTurns,
        ).toBe(0);
        expect(
          (
            await f.request({
              kind: "action",
              pluginId: "framework",
              action: "echo",
              payload: "ok",
            })
          ).status,
        ).toBe(200);
      } finally {
        await f.close();
      }
    },
  );

  it("keeps earlier writes when a later call fails, allows catching and a valid retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setup();
    try {
      f.registry.registerPluginHandler(
        "probe",
        "partial",
        async (_payload, ctx) => {
          await ctx.store.setPluginData!({
            namespace: "notes",
            key: "a",
            value: { id: "a", text: "first" },
          });
          await ctx.store.setPluginData!({
            namespace: "notes",
            key: "b",
            value: { text: 1 },
          });
        },
        {},
        "builtin",
      );
      const action = (action: string) => ({
        kind: "action",
        pluginId: "probe",
        action,
      });
      expect((await f.request(action("partial"))).status).toBe(500);
      const first = await f.rows(f.store);
      expect(first.map((row) => row.key)).toEqual(["a"]);
      f.registry.registerPluginHandler(
        "probe",
        "caught",
        async (_payload, ctx) => {
          try {
            await ctx.store.setPluginData!({
              namespace: "notes",
              key: "b",
              value: {},
            });
          } catch {
            return { caught: true };
          }
        },
        {},
        "builtin",
      );
      expect((await f.request(action("caught"))).status).toBe(200);
      f.registry.registerPluginHandler(
        "probe",
        "retry",
        async (_payload, ctx) => {
          await ctx.store.setPluginData!({
            namespace: "notes",
            key: "b",
            value: { id: "b", text: "second" },
          });
        },
        {},
        "builtin",
      );
      expect((await f.request(action("retry"))).status).toBe(200);
      expect(
        (await f.rows(f.store)).filter((row) => row.key === "b"),
      ).toHaveLength(1);
      expect(
        await f.store.getPluginData(f.options.sessionId, "probe", "notes", "a"),
      ).toEqual(first[0]);
      expect(
        (await f.store.getSession(f.options.sessionId))?.completedPlayerTurns,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("requires the session owner for management overrides on a hosted instance", async () => {
    const f = await setup();
    try {
      f.policy(["inc"]);
      const owner = mintSessionOwnerToken();
      await f.store.updateSession(f.options.sessionId, {
        metadata: { ownerTokenHash: owner.tokenHash },
      });
      const app = new Hono();
      app.use(
        "*",
        hostProfileMiddleware(
          resolveHostProfile(
            readRuntimeEnv({
              DEPLOYMENT_TIER: "demo",
              COVEL_MEDIA_TOKEN_SECRET: "test-media-secret",
              COVEL_DESKTOP_REST_TOKEN: "test-operator-secret",
            }),
            { storeBackend: "memory" },
          ),
        ),
      );
      const lock = createInProcessSessionLock();
      app.use("*", async (c, next) => {
        c.set("store", f.store);
        c.set("pluginRegistry", f.options.preflight.registry);
        c.set("sessionLock", lock);
        await next();
      });
      app.route("/api/sessions", pluginDataRoutes);
      const url = `/api/sessions/${f.options.sessionId}/plugin-data/probe/notes/key`;
      const put = (token?: string) =>
        app.request(url, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ value: { invalid: true } }),
        });
      expect((await put()).status).toBe(401);
      expect((await put("wrong-token")).status).toBe(401);
      expect((await put(owner.token)).status).toBe(200);
      expect((await app.request(url, { method: "DELETE" })).status).toBe(401);
      expect(
        (
          await app.request(url, {
            method: "DELETE",
            headers: { authorization: `Bearer ${owner.token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("keeps management PUT and DELETE as authorized overrides with existing size and namespace limits", async () => {
    const f = await setup();
    try {
      f.policy(["inc"]);
      const base = `/api/sessions/${f.options.sessionId}/plugin-data/probe`;
      const put = (namespace: string, value: unknown) =>
        f.app.request(`${base}/${namespace}/key`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value }),
        });
      expect((await put("notes", { invalid: true })).status).toBe(200);
      expect(
        (
          await f.store.getPluginData(
            f.options.sessionId,
            "probe",
            "notes",
            "key",
          )
        )?.value,
      ).toEqual({ invalid: true });
      expect(
        (await f.app.request(`${base}/notes/key`, { method: "DELETE" })).status,
      ).toBe(200);
      expect(
        (await put("notes", "x".repeat(MAX_PLUGIN_DATA_VALUE_BYTES))).status,
      ).toBe(413);
      expect((await put("_hidden.notes", {})).status).toBe(403);
      await f.store.updateSession(f.options.sessionId, { activePlugins: [] });
      expect((await put("notes", {})).status).toBe(403);
    } finally {
      await f.close();
    }
  });
});
