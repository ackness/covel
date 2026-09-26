import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  createRpcExecutor,
} from "@covel/runtime";
import {
  createPluginRegistry,
  type PluginDiscoveryResult,
  type PluginSource,
} from "@covel/plugin-loader";
import { createRpcApprovalGate } from "@covel/approval";
import type { RuntimeManifest } from "@covel/shared";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(
  [
    { source: "builtin", tier: "self", status: 200 },
    { source: "builtin", tier: "commercial", status: 200 },
    { source: "community", tier: "self", status: 202 },
    { source: "community", tier: "commercial", status: 401 },
    { source: undefined, tier: "self", status: 202 },
  ].flatMap((scenario) =>
    ["action", "command"].map((kind) => ({ ...scenario, kind })),
  ),
)(
  "uses discovery trust for pending $source $kind RPC in $tier",
  async ({ source, tier, status, kind }) => {
    vi.stubEnv("DEPLOYMENT_TIER", tier);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-operator");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "covel-pending-rpc-"),
    );
    try {
      const pluginId = "core-fixture";
      const retryCommand = kind === "command" && source === "builtin";
      await fs.writeFile(
        path.join(rootPath, "entry.mjs"),
        `
      let calls = 0;
      export default function (covel) {
        if (calls++ < ${retryCommand ? 2 : 1}) throw new Error("Transient initialization failure");
        covel.registerRpc("entry-action", async () => ({ done: true }));
      }
    `,
        "utf8",
      );
      const discovery: PluginDiscoveryResult = {
        id: pluginId,
        rootPath,
        isMultiRuntime: false,
        pluginMdPaths: [],
        source: source as PluginSource | undefined,
      };
      const store = createMemoryStore();
      const registry = createPluginRpcRegistry();
      const manifest = {
        name: pluginId,
        pluginId,
        description: pluginId,
        entry: "entry.mjs",
        commands: [
          { name: "probe", description: "Probe", action: "entry-action" },
        ],
      } as RuntimeManifest;
      const parsed = { manifest, promptTemplate: "", rawFrontmatter: {} };
      const pluginRegistry = createPluginRegistry();
      pluginRegistry.register({
        id: pluginId,
        source: source as PluginSource | undefined,
        status: "registered",
        manifest: parsed,
        loadedRuntimes: new Map(),
        summary: {
          id: pluginId,
          name: pluginId,
          description: "Fixture",
          pluginType: "plugin",
          runtimeCount: 0,
        },
      });
      const entries = await createBootstrapPluginEntries({
        pluginRegistry,
        discoveryMap: new Map([[pluginId, discovery]]),
        manifestCache: new Map([[pluginId, [parsed]]]),
        store,
        toolMap: new Map(),
        localToolNames: new Set(),
        pluginToolAccess: new Map(),
        hookPipeline: createHookPipeline(),
        rpcRegistry: registry,
      });
      expect(entries.hasPendingEntry(pluginId)).toBe(true);
      const now = new Date().toISOString();
      await store.createSession({
        id: "session-fixture",
        phase: "playing",
        status: "active",
        completedPlayerTurns: 1,
        setupRuntimes: {},
        activePlugins: [pluginId],
        locale: "en-US",
        createdAt: now,
        updatedAt: now,
        metadata: {
          ownerTokenHash: hashSessionOwnerToken("synthetic-owner"),
          approvalScopeNonce: crypto.randomUUID(),
          sessionIncarnationNonce: crypto.randomUUID(),
        },
      });
      const app = new Hono();
      app.onError((_error, c) => c.json({ error: "Activation failed" }, 500));
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("rpcRegistry", registry);
        c.set("rpcExecutor", createRpcExecutor({ registry }));
        c.set("rpcApprovalGate", createRpcApprovalGate());
        c.set("pluginRegistry", pluginRegistry);
        c.set("hasPendingPluginEntry", entries.hasPendingEntry);
        c.set("activatePluginServerCode", entries.ensurePluginEntry);
        await next();
      });
      app.route("/api/sessions", pluginRpcRoutes);
      const request = () =>
        app.request("/api/sessions/session-fixture/plugin-rpc", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-owner",
          },
          body: JSON.stringify(
            kind === "command"
              ? {
                  kind: "command",
                  commandId: `${pluginId}:probe`,
                  input: "/probe",
                }
              : {
                  kind: "action",
                  pluginId,
                  action: "entry-action",
                  payload: {},
                },
          ),
        });
      if (retryCommand) {
        expect((await request()).status).toBe(500);
        expect(entries.hasPendingEntry(pluginId)).toBe(true);
        expect(pluginRegistry.get(pluginId)?.error).toBeDefined();
      }
      const response = await request();
      expect(response.status).toBe(status);
      expect(entries.hasPendingEntry(pluginId)).toBe(source !== "builtin");
      if (status === 200)
        expect(pluginRegistry.get(pluginId)?.error).toBeUndefined();
      if (status === 202)
        expect(await response.json()).toMatchObject({
          pending: { action: "covel:plugin-server-code" },
        });
      if (status === 401)
        expect(await response.json()).toMatchObject({
          code: "operator_token_required",
        });
      await entries.close();
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  },
);
