/**
 * An automatically scheduled function story provides the story contract
 * without declaring a schema. Its handler may return a bare `narrativeOutput`:
 * the kernel turns that into story segments after the handler returns, and no
 * framework schema checks the return value first.
 */
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

it("commits a schema-less automatic function story that returns narrativeOutput", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-fn-story-"));
  try {
    await fs.writeFile(
      path.join(root, "PLUGIN.md"),
      `---
id: teller
description: Function story
runtime:
  schedule: { stage: narrative }
  io: { visibility: story }
  function: {}
---
`,
    );
    await fs.writeFile(
      path.join(root, "handler.js"),
      'export default async function() { return { outcome: "success", value: { narrativeOutput: "The rain stops." } }; }',
    );
    const discovery = {
      id: "teller",
      rootPath: root,
      isMultiRuntime: false,
      pluginMdPaths: [path.join(root, "PLUGIN.md")],
      source: "builtin" as const,
    };
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests[0]!.manifest.outputContract).toBe(
      "narrative-engine@2",
    );
    const registry = createPluginRegistry();
    registry.register({
      id: "teller",
      source: "builtin",
      summary: {
        id: "teller",
        name: "teller",
        description: "",
        kind: "plugin",
        runtimeCount: definition.manifests.length,
      },
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
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["teller"],
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
      discoveryMap: new Map([["teller", discovery]]),
      manifestCache: new Map([["teller", definition.manifests]]),
      getApprovalGate: () =>
        ({ hasGrant: () => true }) as unknown as RpcApprovalGate,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("eventBus", createEventBus(store));
      c.set("loadRuntimeFn", loader.loadRuntimeFn);
      c.set("withPluginSnapshot", async (sessionId, fn) =>
        (await loader.capture(sessionId)).run(fn),
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
        requestId: "function-story",
        type: "submit_actions",
        sessionId: "session",
        payload: { actions: [{ kind: "say", text: "Wait" }] },
      }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    const story = (await store.listMessages("session")).filter(
      (message) =>
        (message.metadata as { kind?: string } | undefined)?.kind === "story",
    );
    expect(story, stream).toHaveLength(1);
    expect(story[0]).toMatchObject({
      content: "The rain stops.",
      metadata: {
        runtimeId: "teller",
        segments: [{ kind: "narration", text: "The rain stops." }],
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
