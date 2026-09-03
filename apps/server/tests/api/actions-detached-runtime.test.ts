import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type FunctionHandler,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";

import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const SESSION_ID = "detached-action-session";
const PLUGIN_ID = "detached-action-plugin";
const PRODUCER_ID = `${PLUGIN_ID}/producer`;
const LEAF_ID = `${PLUGIN_ID}/leaf`;

describe("POST /api/actions — scheduler-detached runtime", () => {
  it("commits the source turn and durable queue row without running the leaf", async () => {
    const store = createMemoryStore();
    const eventBus = createEventBus(store);
    const registry = createPluginRegistry();
    const leafHandler = vi.fn<FunctionHandler>(async () => ({
      outcome: "success",
      value: {},
      effects: {
        pluginData: [
          { namespace: "tracks", key: "late", value: { status: "done" } },
        ],
      },
    }));
    const manifests: RuntimeManifest[] = [
      {
        name: PRODUCER_ID,
        pluginId: PLUGIN_ID,
        description: "narrative producer",
        version: "1.0.0",
        runtimeType: "function",
        handler: "./producer.js",
        stage: "narrative",
        outputKind: "story",
        capabilities: ["narrative-engine"],
        trigger: { type: "auto" },
      },
      {
        name: LEAF_ID,
        pluginId: PLUGIN_ID,
        description: "detached media leaf",
        version: "1.0.0",
        runtimeType: "function",
        handler: "./leaf.js",
        stage: "post-turn",
        outputKind: "plugin",
        trigger: { type: "auto" },
        needs: [{ capability: "narrative-engine" }],
        inputs: {
          narrative: {
            from: { capability: "narrative-engine", cardinality: "one" },
            select: "/narrativeOutput",
            required: true,
          },
        },
        effects: {
          writes: ["plugin-data:self:tracks", "assets:*", "media:*"],
        },
        turnCompletion: {
          mode: "detached",
          maxQueueMs: 30_000,
          maxExecutionMs: 90_000,
          overlap: "serial",
          stalePolicy: "reject",
        },
      },
    ];
    const loaded = new Map<string, LoadedRuntime>([
      [
        PRODUCER_ID,
        {
          manifest: manifests[0]!,
          promptTemplate: "",
          handler: async () => ({
            outcome: "success",
            value: { narrativeOutput: "The source turn is complete." },
          }),
        },
      ],
      [
        LEAF_ID,
        {
          manifest: manifests[1]!,
          promptTemplate: "",
          handler: leafHandler,
        },
      ],
    ]);
    const parsed = manifests.map((manifest) => ({
      manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    }));
    registry.register({
      id: PLUGIN_ID,
      summary: {
        id: PLUGIN_ID,
        name: PLUGIN_ID,
        description: "",
        pluginType: "plugin",
        runtimeCount: manifests.length,
      },
      manifest: parsed[0],
      manifests: parsed,
      loadedRuntimes: loaded,
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const runtimeJobWorker = { wake: vi.fn(), close: vi.fn(), activeCount: 0 };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", { generate: async () => ({}) } as any);
      c.set("loadRuntimeFn", async (manifest) => loaded.get(manifest.name));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("runtimeJobWorker", runtimeJobWorker);
      await next();
    });
    app.route("/api/actions", actionRoutes);

    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      status: "active",
      locale: "zh-CN",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [PLUGIN_ID],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });

    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "detached-request",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "continue" },
      }),
    });
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).toContain("runtime.deferred");
    expect(stream).toContain("execution.completed");
    expect(leafHandler).not.toHaveBeenCalled();
    expect(runtimeJobWorker.wake).toHaveBeenCalledOnce();
    const [job] = await store.listPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_runtime_jobs",
    );
    expect(job?.value).toMatchObject({
      status: "queued",
      runtimeId: LEAF_ID,
      maxQueueMs: 30_000,
      maxExecutionMs: 90_000,
      payload: {
        descriptor: {
          runtimeId: LEAF_ID,
          upstreamResults: [{ runtimeId: PRODUCER_ID, status: "success" }],
        },
      },
    });
    await expect(
      store.listJobStatus(SESSION_ID, { jobId: job?.key }),
    ).resolves.toMatchObject([{ state: "queued", sequence: 0 }]);
  });
});
