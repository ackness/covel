import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import type { RpcApprovalGate } from "@covel/approval";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createRuntimeLoader } from "../../src/routes/api/bootstrap/runtime-loader.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

it("publishes recordAs exports from a player action inside the real runtime artifact snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-action-export-"));
  try {
    await fs.writeFile(
      path.join(root, "PLUGIN.md"),
      `---
id: producer
kind: plugin
description: Export fixture
runtime:
  type: function
  schedule:
    stage: narrative
    trigger:
      type: auto
  function:
    handler: ./handler.mjs
  io:
    output:
      schema: ./output.json
      recordAs: story-v1
    visibility: story
---
`,
    );
    await fs.writeFile(
      path.join(root, "handler.mjs"),
      'export default async function() { return { outcome: "success", value: { narrativeOutput: "The journey continues." } }; }',
    );
    await fs.writeFile(
      path.join(root, "PLUGIN.zh.md"),
      (await fs.readFile(path.join(root, "PLUGIN.md"), "utf-8")) +
        "中文捕获正文。\n",
    );
    await fs.writeFile(
      path.join(root, "output.json"),
      JSON.stringify({
        type: "object",
        required: ["narrativeOutput"],
        properties: { narrativeOutput: { type: "string" } },
      }),
    );
    const discovery = {
      id: "producer",
      rootPath: root,
      isMultiRuntime: false,
      pluginMdPaths: [path.join(root, "PLUGIN.md")],
      source: "builtin" as const,
    };
    const definition = await loadPluginDefinition(discovery);
    const registry = createPluginRegistry();
    registry.register({
      id: "producer",
      source: "builtin",
      rootPath: root,
      status: "registered",
      packageManifest: definition.packageManifest,
      manifests: definition.manifests,
      loadedRuntimes: new Map(),
    });
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "session",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: ["producer"],
      metadata: {
        approvalScopeNonce: "approval-fixture",
        sessionIncarnationNonce: "session-fixture",
      },
      locale: "en-US",
      createdAt: now,
      updatedAt: now,
    });
    const loader = createRuntimeLoader({
      store,
      pluginRegistry: registry,
      discoveryMap: new Map([["producer", discovery]]),
      manifestCache: new Map([["producer", definition.manifests]]),
      getApprovalGate: () =>
        ({ hasGrant: () => true }) as unknown as RpcApprovalGate,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("eventBus", createEventBus(store));
      c.set("loadRuntimeFn", async (...args) => {
        const loaded = await loader.loadRuntimeFn(...args);
        expect(loaded?.promptTemplate).toContain("中文捕获正文。");
        return loaded;
      });
      c.set(
        "withPluginSnapshot",
        async (sessionId, fn, _beforeCapture, locale) => {
          expect((await store.getSession(sessionId))?.locale).toBe("en-US");
          expect(locale).toBe("zh-CN");
          return (await loader.capture(sessionId, locale)).run(async () => {
            const loaded = await loader.loadRuntimeFn(
              definition.manifests[0]!.manifest,
              undefined,
              sessionId,
            );
            expect(loaded?.promptTemplate).toContain("中文捕获正文。");
            return fn();
          });
        },
      );
      c.set("resolveModel", () => undefined);
      c.set("llmAdapter", {
        generate: async () => {
          throw new Error("function must not call a model");
        },
      });
      await next();
    });
    app.route("/api/actions", actionRoutes);
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "export-action",
        type: "send_message",
        sessionId: "session",
        locale: "zh-CN",
        payload: { content: "Continue" },
      }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    expect((await store.getSession("session"))?.locale).toBe("zh-CN");
    const exports = await store.listRuntimeExports("session");
    expect(exports, stream).toHaveLength(1);
    expect(exports[0]).toMatchObject({
      producerRuntimeId: "producer",
      recordAs: "story-v1",
      value: { narrativeOutput: "The journey continues." },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
