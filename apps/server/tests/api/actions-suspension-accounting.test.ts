import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createHookPipeline } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { actionRoutes, setMemorySystem } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const SESSION_ID = "session-suspension-accounting";
const PLUGIN_ID = "suspension-fixture";

function manifest(
  name: string,
  resultFormat: RuntimeManifest["resultFormat"] = "legacy",
): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: name,
    stage: "narrative",
    runtimeType: "function",
    trigger: { type: "auto" },
    outputKind: "plugin",
    resultFormat,
  };
}

async function runScenario(options: { readonly failCommit: boolean }) {
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION_ID,
    worldId: null,
    status: "active",
    activePlugins: [PLUGIN_ID],
    phase: "playing",
    completedPlayerTurns: 3,
    setupRuntimes: {},
    turnCount: 3,
    preGameCompleted: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });

  const suspendManifest = manifest("suspension-fixture/suspend", "envelope-v1");
  const writerManifest = manifest("suspension-fixture/writer");
  const loaded = new Map<string, LoadedRuntime>([
    [
      suspendManifest.name,
      {
        manifest: suspendManifest,
        promptTemplate: "",
        handler: async () => ({
          outcome: "suspended",
          reason: "need a choice",
          resumeSchema: { type: "string" },
        }),
      },
    ],
    [
      writerManifest.name,
      {
        manifest: writerManifest,
        promptTemplate: "",
        handler: async () => ({
          statePatches: [{ table: "world", field: "weather", value: "rain" }],
        }),
      },
    ],
  ]);
  const manifests = options.failCommit
    ? [suspendManifest, writerManifest]
    : [suspendManifest];
  const registry = createPluginRegistry();
  registry.register({
    id: PLUGIN_ID,
    summary: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "",
      version: "0.0.0",
      pluginType: "plugin",
      source: "builtin",
      runtimeCount: manifests.length,
    },
    manifests: manifests.map((runtimeManifest) => ({
      manifest: runtimeManifest,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
    loadedRuntimes: loaded,
    status: "registered",
  } as PluginRegistryEntry);

  const hookPipeline = createHookPipeline();
  if (options.failCommit) {
    hookPipeline.register({
      id: "reject-writer",
      event: "PreStateCommit",
      handler: async () => ({ action: "abort", reason: "forced rollback" }),
    });
  }

  const app = new Hono();
  const eventBus = createEventBus(store);
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", {
      generate: async () => {
        throw new Error("function runtimes must not call the LLM");
      },
    });
    c.set("loadRuntimeFn", async (runtimeManifest: RuntimeManifest) =>
      loaded.get(runtimeManifest.name),
    );
    c.set("toolExecutor", undefined);
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("sessionLock", createInProcessSessionLock());
    c.set("hookPipeline", hookPipeline);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  setMemorySystem(undefined);

  const response = await app.request("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: `request-${options.failCommit ? "rollback" : "suspend"}`,
      type: "send_message",
      sessionId: SESSION_ID,
      payload: { content: "continue" },
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  return { store };
}

describe("POST /api/actions suspension accounting", () => {
  it("does not complete the logical player turn at the suspension boundary", async () => {
    const { store } = await runScenario({ failCommit: false });

    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(3);
    expect(await store.listSuspensions(SESSION_ID)).toHaveLength(1);
  });

  it("removes a continuation when a sibling proposal rolls back", async () => {
    const { store } = await runScenario({ failCommit: true });

    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(3);
    expect(await store.listSuspensions(SESSION_ID)).toHaveLength(0);
  });
});
