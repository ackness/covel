import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type {
  RuntimeManifest,
  RuntimeResult,
  SseEnvelope,
} from "@covel/shared";
import { actionRoutes } from "../../../src/routes/api/actions.js";
import { turnControlRoutes } from "../../../src/routes/api/turn-control-routes.js";
import { createInProcessSessionLock } from "../../../src/lib/session-lock.js";

export function seedResult(
  runtimeId: string,
  status: RuntimeResult["status"],
): RuntimeResult {
  return {
    runtimeId,
    pluginId: runtimeId,
    runId: `source-${runtimeId}`,
    turnId: "source",
    status,
    output: status === "success" ? { text: "Original story" } : null,
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-01-01T00:00:00Z",
  };
}

export async function batchRetryFixture() {
  const store = createMemoryStore();
  const sessionId = crypto.randomUUID();
  const registry = createPluginRegistry();
  const loadedByName = new Map<string, LoadedRuntime>();
  const calls: string[] = [];
  const failures = new Set<string>();
  let beforeRun: ((runtimeId: string) => Promise<void>) | undefined;
  for (const name of ["story", "a", "b", "successful"]) {
    const manifest: RuntimeManifest = {
      name,
      pluginId: name,
      description: name,
      pluginType: "core-plugin",
      runtimeType: "function",
      handler: "./handler.js",
      outputKind: name === "story" ? "story" : "system",
      stage: name === "story" ? "narrative" : "post-turn",
      trigger: { type: "auto" },
      maxRetries: 0,
      ...(name === "a" || name === "b"
        ? {
            needs: ["story"],
            inputs: { story: { from: { runtime: "story" }, required: true } },
          }
        : {}),
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "",
      handler: async (ctx) => {
        calls.push(name);
        await beforeRun?.(name);
        if (failures.has(name)) throw new Error(`Synthetic ${name} failure`);
        const handlerStore = ctx.store as DataStore;
        await handlerStore.setPluginData({
          id: `data-${name}`,
          sessionId,
          pluginId: name,
          namespace: "test",
          key: "result",
          value: { input: ctx.inputs?.story?.value ?? null },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return { outcome: "success", value: { ok: true } };
      },
    };
    loadedByName.set(name, loaded);
    const parsed = { manifest, promptTemplate: "", rawFrontmatter: {} };
    registry.register({
      id: name,
      summary: {
        id: name,
        name,
        description: "",
        pluginType: "core-plugin",
        runtimeCount: 1,
      },
      manifest: parsed,
      manifests: [parsed],
      loadedRuntimes: new Map([[name, loaded]]),
      status: "registered",
    } as PluginRegistryEntry);
  }
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    activePlugins: [...loadedByName.keys()],
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    completedPlayerTurns: 2,
    setupRuntimes: {},
    createdAt: "2026-01-01T00:00:00Z",
  });
  await store.saveTurnResult({
    id: "source",
    sessionId,
    turnId: "source",
    origin: "player",
    commitStatus: "committed",
    runtimeResults: [
      seedResult("story", "success"),
      seedResult("a", "failed"),
      seedResult("b", "failed"),
      seedResult("successful", "success"),
    ],
    durationMs: 1,
    createdAt: "2026-01-01T00:00:00Z",
  });
  const lock = createInProcessSessionLock();
  const bus = createEventBus(store);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("getPluginSource", () => "builtin");
    c.set("llmAdapter", {
      generate: async () => {
        throw new Error("No live models in fixture");
      },
    });
    c.set("loadRuntimeFn", async (manifest) => loadedByName.get(manifest.name));
    c.set("resolveModel", () => undefined);
    c.set("eventBus", bus);
    c.set("sessionLock", lock);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  app.route("/api/sessions", turnControlRoutes);
  const open = (
    payload: Record<string, unknown> = {
      runtimeIds: ["a", "b"],
      retryFromTurnId: "source",
    },
    type = "retry_failed_runtimes",
  ) =>
    app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId,
        type,
        payload,
      }),
    });
  const post = async (...args: Parameters<typeof open>) => {
    const response = await open(...args);
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as SseEnvelope);
    return { status: response.status, events, text };
  };
  const status = async () =>
    (await app.request(`/api/sessions/${sessionId}/execution`)).json();
  return {
    store,
    sessionId,
    registry,
    calls,
    failures,
    post,
    open,
    status,
    beforeRun: (callback: (runtimeId: string) => Promise<void>) => {
      beforeRun = callback;
    },
  };
}
