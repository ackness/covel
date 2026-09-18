import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import {
  createPluginRegistry,
  type ParsedPluginMd,
  type PluginRuntimeGateway,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { LLMAdapter } from "@covel/runtime";
import type { AiStack } from "../../src/ai-setup.js";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { createBootstrapMemorySystem } from "../../src/routes/api/bootstrap/memory.js";
import { requestLlmServices } from "../../src/routes/api/bootstrap/request-llm-services.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import { resumeRoutes } from "../../src/routes/api/resume.js";

const input = {
  sessionId: "session",
  turnId: "turn",
  traceId: "trace",
  narrativeText: "The harbor opened.",
  currentBlocks: [],
};
const response = {
  content: "{}",
  toolCalls: [],
  finishReason: "stop" as const,
};

async function createFixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "session",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    worldId: null,
    completedPlayerTurns: 1,
    activePlugins: ["panel-host"],
    metadata: {
      sessionIncarnationNonce: "fixture-incarnation",
      approvalScopeNonce: "fixture-scope",
    },
    createdAt: new Date().toISOString(),
  });
  const manifestCache = new Map<string, readonly ParsedPluginMd[]>([
    [
      "panel-host",
      [
        {
          manifest: {
            name: "panel-host",
            pluginId: "panel-host",
            description: "Memory UI",
            capabilities: ["memory-panel"],
          },
          promptTemplate: "",
          rawFrontmatter: {},
        },
      ],
    ],
  ]);
  return { store, manifestCache };
}

describe("request-scoped memory lifecycle", () => {
  it("extracts resumed narrative only after a successful resume commit", async () => {
    const fixture = await createFixture();
    await fixture.store.updateSession("session", {
      activePlugins: ["panel-host", "narrator-fixture"],
    });
    const registry = createPluginRegistry();
    const manifest: RuntimeManifest = {
      name: "narrator-fixture",
      pluginId: "narrator-fixture",
      description: "Fixture narrator",
      runtimeType: "agent",
      stage: "narrative",
      outputKind: "story",
    };
    registry.register({
      id: manifest.pluginId,
      summary: {
        id: manifest.pluginId,
        name: "Fixture",
        description: "",
        version: "0.0.0",
        pluginType: "community",
        source: "community",
      },
      manifests: [{ manifest, promptTemplate: "Resume the story." }],
      loadedRuntimes: new Map(),
      status: "loaded",
    });
    const generate = vi
      .fn<LLMAdapter["generate"]>()
      .mockResolvedValue(response);
    const memory = createBootstrapMemorySystem({
      ...fixture,
      llmAdapter: { generate },
      resolveModel: (runtime) => runtime.model,
    })!.memorySystem;
    await fixture.store.saveSuspension({
      id: "suspension",
      sessionId: "session",
      turnId: "suspended-turn",
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      reason: "Player choice",
      resumeSchema: { type: "object" },
      pendingContinuation: {
        executionContext: {
          executionId: "previous-run",
          origin: "player",
          countPolicy: "none",
        },
        messages: [{ role: "system", content: "Resume the story." }],
        toolCallsSoFar: [],
        pendingProposals: [],
      },
      createdAt: new Date().toISOString(),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", fixture.store);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("pluginRegistry", registry);
      c.set("memorySystem", memory);
      c.set("llmAdapter", {
        generate: async () => ({
          ...response,
          content: '{"narrativeOutput":"The player entered the harbor."}',
        }),
      });
      c.set("loadRuntimeFn", async () => ({
        manifest,
        promptTemplate: "Resume the story.",
      }));
      await next();
    });
    app.route("/api/sessions", resumeRoutes);
    const res = await app.request(
      "/api/sessions/session/suspensions/suspension/resume",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: {} }),
      },
    );
    expect(res.status).toBe(200);
    expect(
      (await fixture.store.getSuspension("suspension"))?.resolvedAt,
    ).toBeTruthy();
    await memory.updater.awaitPending("session");
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(generate.mock.calls[0])).toContain(
      "The player entered the harbor.",
    );
    const status = await fixture.store.getPluginData(
      "session",
      "panel-host",
      "_memory",
      "update",
    );
    expect(status?.value).toMatchObject({
      status: "succeeded",
      turnId: "suspended-turn",
    });
  });

  it("honors browser memory binding and provider keys without changing later requests", async () => {
    const fixture = await createFixture();
    const generate = vi
      .fn<LLMAdapter["generate"]>()
      .mockResolvedValue(response);
    const defaultAdapter = { generate };
    let fallbackSlot = "plugin";
    const memory = createBootstrapMemorySystem({
      ...fixture,
      llmAdapter: defaultAdapter,
      preferredMemorySlot: () => fallbackSlot,
      resolveModel: (manifest) => manifest.model,
    })!;
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: "{}", toolCalls: [], finishReason: "stop" });
    const ai = { gateway: { generateText } } as unknown as AiStack;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("llmAdapter", defaultAdapter);
      c.set("memorySystem", memory.memorySystem);
      await next();
    });
    app.use(
      "*",
      createPerRequestLlmMiddleware({
        ai,
        envApiKeys: {},
        defaultLlmAdapter: defaultAdapter,
        defaultPluginGateway: {} as PluginRuntimeGateway,
      }),
    );
    app.use("*", requestLlmServices(fixture, memory));
    app.post("/update", async (c) =>
      c.json(await c.get("memorySystem")!.updater.updateAfterTurn(input)),
    );

    const encode = (data: unknown) =>
      Buffer.from(JSON.stringify(data)).toString("base64");
    const res = await app.request("/update", {
      method: "POST",
      headers: {
        "X-Provider-Keys": encode({ fixture: "synthetic-browser-key" }),
        "X-Slot-Config": encode({
          slotPresetOverrides: { memory: "custom-memory" },
        }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: false });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ presetId: "memory" }),
      expect.objectContaining({
        apiKeys: { fixture: "synthetic-browser-key" },
        slotOverrides: expect.objectContaining({
          slotPresetOverrides: { memory: "custom-memory" },
        }),
      }),
    );
    expect(generate).not.toHaveBeenCalled();

    await app.request("/update", { method: "POST" });
    fallbackSlot = "story";
    await app.request("/update", { method: "POST" });
    expect(generate.mock.calls.map(([request]) => request.model)).toEqual([
      "plugin",
      "story",
    ]);
    expect(
      generate.mock.calls.every(
        ([request]) => request.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("records a failed extraction with its turn and clears the warning after recovery", async () => {
    const fixture = await createFixture();
    const generate = vi
      .fn<LLMAdapter["generate"]>()
      .mockResolvedValueOnce({ ...response, content: "not JSON" })
      .mockResolvedValueOnce({ ...response, content: '{"scene":"harbor"}' });
    const memory = createBootstrapMemorySystem({
      ...fixture,
      llmAdapter: { generate },
      preferredMemorySlot: "memory",
      resolveModel: (manifest) => manifest.model,
    })!.memorySystem;
    expect(await memory.updater.updateAfterTurn(input)).toMatchObject({
      error: expect.stringContaining("invalid JSON"),
    });
    const failed = await fixture.store.getPluginData(
      "session",
      "panel-host",
      "_memory",
      "update",
    );
    expect(failed?.value).toMatchObject({
      status: "failed",
      turnId: "turn",
      slot: "memory",
      updated: false,
    });
    expect(await fixture.store.listTraceEvents("session")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "memory.updated",
          turnId: "turn",
          traceId: "trace",
        }),
      ]),
    );
    await memory.updater.updateAfterTurn({ ...input, turnId: "next-turn" });
    await memory.updater.awaitPending("session");
    const recovered = await fixture.store.getPluginData(
      "session",
      "panel-host",
      "_memory",
      "update",
    );
    expect(recovered?.value).toMatchObject({
      status: "succeeded",
      turnId: "next-turn",
      blocksChanged: ["scene"],
    });
    expect(recovered?.value).not.toHaveProperty("error");
  });

  it("finishes a pending update before taking a manual snapshot", async () => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const memory = createBootstrapMemorySystem({
      ...fixture,
      llmAdapter: {
        generate: async () => {
          started.resolve();
          await released.promise;
          return { ...response, content: '{"scene":"committed harbor"}' };
        },
      },
      resolveModel: (manifest) => manifest.model,
    })!.memorySystem;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", fixture.store);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("memorySystem", memory);
      await next();
    });
    app.route("/api/sessions", snapshotRoutes);
    const update = memory.updater.updateAfterTurn(input);
    await started.promise;
    let finished = false;
    const snapshot = app
      .request("/api/sessions/session/snapshots", { method: "POST" })
      .then((res) => {
        finished = true;
        return res;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    released.resolve();
    await update;
    const res = await snapshot;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const saved = await fixture.store.getSnapshot(body.id);
    expect(JSON.stringify(saved)).toContain("committed harbor");
  });
});
