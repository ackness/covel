import { createEventBus } from "@covel/events";
import type { LLMAdapter, RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime, PluginRegistryEntry } from "@covel/plugin-loader";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";
// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

describe("a minimal world", () => {
  it("loads, validates and starts a session with three fields and WORLD.md", async () => {
    // The directory names the world: world.yaml has no `id`.
    const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-minimal-"));
    const worldDir = path.join(worldsDir, "quiet-harbor");
    await mkdir(worldDir);
    await writeFile(
      path.join(worldDir, "world.yaml"),
      "name: Quiet Harbor\nsummary: A harbor where nothing has happened yet.\ndefaultLocale: en-US\n",
    );
    await writeFile(
      path.join(worldDir, "WORLD.md"),
      "# Quiet Harbor\n\nFog, a pier and one lamp.\n",
    );

    const validation = await validateWorldPackage({
      worldDir,
      pluginsDirs: [path.join(repoRoot, "plugins")],
      strict: true,
    });
    expect(validation.worldId).toBe("quiet-harbor");
    expect(validation.diagnostics).toEqual([]);

    const world = await loadSingleWorld(worldDir);
    expect(world).toMatchObject({
      id: "quiet-harbor",
      name: "Quiet Harbor",
      locale: "en-US",
    });

    const discovery = (
      await discoverPlugins(path.join(repoRoot, "plugins"))
    ).find((plugin) => plugin.id === "narrator");
    if (!discovery) throw new Error("Narrator fixture missing");
    const definition = await loadPluginDefinition(discovery);
    const registry = createPluginRegistry();
    registry.register({
      id: discovery.id,
      source: "builtin",
      rootPath: discovery.rootPath,
      summary: {
        id: discovery.id,
        name: discovery.id,
        description: "",
        kind: "plugin",
        runtimeCount: definition.manifests.length,
      },
      ...definition,
      loadedRuntimes: new Map(),
      status: "registered",
    });
    const store = createMemoryStore();
    await store.upsertWorld(world!);
    const lock = createInProcessSessionLock();
    const gate = createRpcApprovalGate();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("worldsDirs", [worldsDir]);
      c.set("sessionLock", lock);
      c.set("rpcApprovalGate", gate);
      c.set("activatePluginServerCode", async () => {});
      await next();
    });
    app.route("/api/sessions", sessionRoutes);

    const response = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "minimal-session",
        worldId: "quiet-harbor",
        plugins: ["narrator"],
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(201);
    expect(await store.getSession("minimal-session")).toMatchObject({
      worldId: "quiet-harbor",
      locale: "en-US",
      activePlugins: ["narrator"],
      phase: "playing",
    });
    await store.close();
  });
});

it("commits story-only opening and player turns despite an unavailable world contract", async () => {
  const store = createMemoryStore();
  const eventBus = createEventBus(store);
  const sessionLock = createInProcessSessionLock();
  const pluginRegistry = createPluginRegistry();
  const manifest: RuntimeManifest = {
    name: "story-fixture/story",
    pluginId: "story-fixture",
    description: "",
    runtimeType: "function",
    handler: "handler.js",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
  };
  const loaded: LoadedRuntime = {
    manifest,
    promptTemplate: "",
    handler: async () => ({
      outcome: "success",
      value: { narrativeOutput: "The lamp stays lit." },
    }),
  };
  pluginRegistry.register({
    id: manifest.pluginId,
    source: "builtin",
    summary: {
      id: manifest.pluginId,
      name: "Story",
      description: "",
      kind: "core",
      runtimeCount: 1,
    },
    manifests: [
      {
        manifest,
        runtime: { function: {} },
        promptTemplate: "",
        rawFrontmatter: {},
      },
    ],
    loadedRuntimes: new Map([[manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry);
  const llm: LLMAdapter = {
    generate: async () => {
      throw new Error("Story fixture uses no model");
    },
  };
  const loadRuntimeFn = async () => loaded;
  const runtimeJobWorker = createTestRuntimeJobWorker({
    store,
    eventBus,
    sessionLock,
    pluginRegistry,
    deps: { loadRuntime: loadRuntimeFn, llm, resolveModel: () => undefined },
  });
  await store.upsertWorld({
    id: "watch",
    name: "Watch",
    description: "Keep the lamp lit.",
    locale: "en-US",
    metadata: {
      plugins: ["plugin:story-fixture", "contract:unavailable-check@1"],
    },
    createdAt: new Date().toISOString(),
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("eventBus", eventBus);
    c.set("sessionLock", sessionLock);
    c.set("pluginRegistry", pluginRegistry);
    c.set("runtimeJobWorker", runtimeJobWorker);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", loadRuntimeFn);
    c.set("resolveModel", () => undefined);
    c.set("rpcApprovalGate", createRpcApprovalGate());
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/actions", actionRoutes);
  const create = (
    id: string,
    plugins: string[],
    excludedPlugins: string[] = [],
  ) =>
    app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, worldId: "watch", plugins, excludedPlugins }),
    });
  try {
    const response = await create("watch-session", [manifest.pluginId]);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      unmetRequirements: [
        { contract: "unavailable-check@1", code: "missing-provider" },
      ],
    });
    expect(
      (await store.getSession("watch-session"))?.metadata?.pluginSelection,
    ).toMatchObject({
      requiredContracts: ["unavailable-check@1"],
    });
    for (const type of ["start_session", "submit_actions"]) {
      const result = await app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          type,
          sessionId: "watch-session",
          payload:
            type === "submit_actions"
              ? { actions: [{ kind: "say", text: "Keep watch." }] }
              : {},
        }),
      });
      expect(result.status, await result.text()).toBe(200);
    }
    const turns = await store.listTurnResults("watch-session");
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.commitStatus === "committed")).toBe(true);
    const empty = await create("empty-session", [], [manifest.pluginId]);
    expect(empty.status).toBe(201);
    expect((await store.getSession("empty-session"))?.activePlugins).toEqual(
      [],
    );
  } finally {
    await runtimeJobWorker.close();
    await store.close();
  }
});
