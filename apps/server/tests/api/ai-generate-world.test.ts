import { registerDimensionProvider } from "../helpers/dimension-provider.js";
import {
  createPluginRegistry,
  parsePluginMd,
  discoverPlugins,
  loadPluginDefinition,
  type PluginRegistry,
} from "@covel/plugin-loader";
import {
  importWorldDataForSession,
  preflightWorldDataForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";
import { worldCrudRoutes } from "../../src/routes/api/worlds/crud.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import * as worldCreation from "@covel/create";
import { aiRoutes } from "../../src/routes/api/ai.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { createApplicationWork } from "../../src/application-work.js";

const WORLD_YAML = `schemaVersion: "1.0"
id: generated-world
name: 生成世界
version: 0.1.0
summary: 一个生成世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [test]
requiredPlugins: []
recommendedPlugins: []
dimensions:
  geography:
    name: geography
    schema: {}
    initialValue:
      regions:
        - name: 中央区
          description: 核心区域。
          climate: 温和
  tone:
    name: tone
    schema: {}
    initialValue:
      genres:
        - mystery
      contentRating: teen
  startingConditions:
    name: startingConditions
    schema: {}
    initialValue:
      openingScenario: 钟声提前响起，玩家必须立刻选择追踪声源或保护证人。
`;

const WORLD_MD = `# 生成世界

钟声提前响起，城市的三座钟楼开始互相改写时间。

1. 追踪第一座钟楼。
2. 保护被追捕的钟匠。
3. 关闭中央齿轮。`;

const WORLD_PACKAGE_YAML = `characters:
  - { schemaVersion: 1, id: keeper, name: 守钟人, role: npc }
  - { schemaVersion: 1, id: courier, name: 信使, role: companion }
  - { schemaVersion: 1, id: thief, name: 窃时者, role: npc }
lorebook:
  - { id: tower, content: 钟楼控制全城时间。, strategy: selective, keys: [钟楼] }
  - { id: rain, content: 雨水显出被删除的道路。, strategy: selective, keys: [雨] }
  - { id: guild, content: 公会垄断校时权。, strategy: selective, keys: [公会] }
  - { id: reverse-hour, content: 倒转之时会先删除记忆。, strategy: constant }
rules:
  - { id: time-cost, content: 改写时间必须失去记忆。, strategy: constant }
  - { id: rain-reveals, content: 被删除的痕迹只在雨中出现。, strategy: constant }
  - { id: clocks-disagree, content: 不同阵营的钟显示不同时间。, strategy: constant }`;

class FixedLlm implements LLMAdapter {
  constructor(
    private readonly content = `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===END===`,
  ) {}

  async generate(): Promise<LLMResponse> {
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

type Env = {
  Variables: {
    llmAdapter: LLMAdapter;
    store: DataStore;
  };
};

function createTestApp(
  store: DataStore,
  llm: LLMAdapter = new FixedLlm(),
  registry?: PluginRegistry,
): Hono<Env> {
  const app = new Hono<Env>();
  const sessionLock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("llmAdapter", llm);
    c.set("store", store);
    if (registry) c.set("pluginRegistry", registry);
    c.set("sessionLock", sessionLock);
    c.set("storeBackend", "memory");
    await next();
  });
  app.route("/api/ai", aiRoutes);
  app.route("/api/worlds", worldCrudRoutes);
  return app;
}

async function readSseJson(
  res: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("ai world generation route", () => {
  let requestWindow = 0;
  let store: DataStore;
  let app: Hono<Env>;
  let worldsDir: string;
  const previousStoreBackend = process.env.STORE_BACKEND;
  const previousUserWorldsDir = process.env.COVEL_USER_WORLDS_DIR;
  const previousWorldsDir = process.env.COVEL_WORLDS_DIR;

  beforeEach(async () => {
    // Each fixture owns a fresh limiter window; added cases must not consume
    // the validation case's quota through the shared module-level route.
    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + ++requestWindow * 60_001,
    );
    store = createMemoryStore();
    app = createTestApp(store);
    worldsDir = await mkdtemp(path.join(tmpdir(), "covel-ai-worlds-"));
    await mkdir(worldsDir, { recursive: true });
    process.env.STORE_BACKEND = "memory";
    process.env.COVEL_USER_WORLDS_DIR = worldsDir;
    delete process.env.COVEL_WORLDS_DIR;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (previousStoreBackend === undefined) {
      delete process.env.STORE_BACKEND;
    } else {
      process.env.STORE_BACKEND = previousStoreBackend;
    }
    if (previousUserWorldsDir === undefined) {
      delete process.env.COVEL_USER_WORLDS_DIR;
    } else {
      process.env.COVEL_USER_WORLDS_DIR = previousUserWorldsDir;
    }
    if (previousWorldsDir === undefined) {
      delete process.env.COVEL_WORLDS_DIR;
    } else {
      process.env.COVEL_WORLDS_DIR = previousWorldsDir;
    }
    await rm(worldsDir, { recursive: true, force: true });
  });

  it.each(["server-store", "return-only"] as const)(
    "%s uses validated generation content without exporting a temporary package",
    async (saveTarget) => {
      const exporter = vi
        .spyOn(worldCreation, "writeWorldPackage")
        .mockRejectedValue(new Error("File export is unavailable"));
      const response = await app.request("/api/ai/generate-world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "Clockwork city", saveTarget }),
      });
      const events = await readSseJson(response);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(
        events.find((event) => event.type === "done")?.world,
      ).toMatchObject({
        id: "generated-world",
        name: "生成世界",
        lore: WORLD_MD,
        metadata: {
          dimensions: {
            geography: {
              name: "geography",
              schema: {},
              initialValue: { regions: [{ name: "中央区" }] },
            },
          },
        },
      });
      expect(exporter).not.toHaveBeenCalled();
      expect(await readdir(worldsDir)).toEqual([]);
    },
  );

  it.each(["server-file", "server-store", "return-only"] as const)(
    "%s returns the same normalized manifest fields",
    async (saveTarget) => {
      const yaml = WORLD_YAML.replace(
        "defaultLocale: zh-CN",
        "defaultLocale: zh_hant_tw",
      )
        .replace(
          "supportedLocales: [zh-CN]",
          "supportedLocales: [zh_hant_tw, en_us]",
        )
        .replace(
          "tags: [test]",
          "tags: [test]\ncharacterSchema:\n  attributes:\n    - id: affinity\n      name: 关系\n      type: number\n      category: social\npluginSettings:\n  memory:\n    cadence: 2",
        );
      app = createTestApp(
        store,
        new FixedLlm(
          `===WORLD_YAML===\n${yaml}\n===WORLD_MD===\n${WORLD_MD}\n===END===`,
        ),
      );

      const response = await app.request("/api/ai/generate-world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "Clockwork city", saveTarget }),
      });
      const events = await readSseJson(response);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      const done = events.find((event) => event.type === "done") as {
        world: import("@covel/store").WorldRecord;
      };
      expect(done.world).toMatchObject({
        locale: "zh-Hant-TW",
        metadata: {
          characterSchema: {
            types: ["npc", "companion"],
            attributes: [
              {
                id: "affinity",
                name: "关系",
                type: "number",
                category: "social",
              },
            ],
          },
          pluginSettings: { memory: { cadence: 2 } },
          dimensions: {
            geography: {
              name: "geography",
              schema: {},
              initialValue: { regions: [{ name: "中央区" }] },
            },
          },
        },
      });
      if (saveTarget === "return-only") {
        expect(await store.getWorld(done.world.id)).toBeNull();
      } else {
        expect(await store.getWorld(done.world.id)).toMatchObject({
          locale: "zh-Hant-TW",
          metadata: { characterSchema: { types: ["npc", "companion"] } },
        });
      }
    },
  );

  it.each(["server-file", "server-store", "return-only"] as const)(
    "%s preserves generated memory definitions through session import",
    async (saveTarget) => {
      const discovery = (
        await discoverPlugins(
          path.resolve(import.meta.dirname, "../../../../plugins"),
        )
      ).find((item) => item.id === "memory")!;
      const definition = await loadPluginDefinition(discovery);
      const registry = createPluginRegistry();
      registry.register({
        id: discovery.id,
        rootPath: discovery.rootPath,
        summary: {
          id: discovery.id,
          name: "Memory",
          description: "",
          pluginType: "core-plugin",
          runtimeCount: 0,
        },
        manifests: [],
        packageManifest: definition.packageManifest,
        loadedRuntimes: new Map(),
        status: "registered",
      });
      await registerDimensionProvider(registry);
      const blocks = [
        {
          label: "tides",
          displayName: "Tides",
          extractionHint: "Track changing tides",
        },
        {
          label: "debts",
          displayName: "Debts",
          extractionHint: "Track favors owed",
        },
      ];
      app = createTestApp(
        store,
        new FixedLlm(
          `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${JSON.stringify(
            {
              contractData: [
                {
                  contract: "memory.blocks@1",
                  key: "world",
                  value: { id: "world", blocks },
                },
              ],
            },
          )}\n===END===`,
        ),
        registry,
      );
      const response = await app.request("/api/ai/generate-world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: "Tidal city",
          saveTarget,
          brief: { contracts: ["memory.blocks@1"] },
        }),
      });
      const events = await readSseJson(response);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      const done = events.find((event) => event.type === "done") as {
        world: import("@covel/store").WorldRecord;
      };
      expect(done.world.metadata?.contractData).toEqual([
        {
          contract: "memory.blocks@1",
          key: "world",
          value: { id: "world", blocks },
        },
      ]);
      if (saveTarget === "return-only") await store.createWorld(done.world);
      const now = new Date().toISOString();
      await store.createSession({
        id: "memory-session",
        worldId: done.world.id,
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: ["world-init", "memory"],
        createdAt: now,
        updatedAt: now,
      });
      const imported = await importWorldDataForSession({
        store,
        sessionId: "memory-session",
        worldId: done.world.id,
        worldsDirs: [worldsDir],
        now,
        preflight: { registry, activePlugins: ["world-init", "memory"] },
      });
      expect(
        imported.diagnostics.filter((item) => item.level === "error"),
      ).toEqual([]);
      expect(
        (
          await store.getPluginData(
            "memory-session",
            "memory",
            "definitions",
            "world",
          )
        )?.value,
      ).toEqual({ id: "world", blocks });
    },
  );

  it.each(["server-file", "server-store", "return-only"] as const)(
    "%s preserves generated time contracts through session import",
    async (saveTarget) => {
      const discoveries = await discoverPlugins(
        path.resolve(import.meta.dirname, "../../../../plugins"),
      );
      const discovery = discoveries.find((item) => item.id === "world-time")!;
      const definition = await loadPluginDefinition(discovery);
      const registry = createPluginRegistry();
      // A different receiver ID must work without changes to world data.
      const pluginId =
        saveTarget === "return-only" ? "alternate-clock" : "world-time";
      const namespace =
        saveTarget === "return-only" ? "calendars" : "definitions";
      registry.register({
        id: pluginId,
        summary: {
          id: pluginId,
          name: pluginId,
          description: "",
          pluginType: "plugin",
          runtimeCount: 0,
        },
        rootPath: discovery.rootPath,
        manifests: [],
        packageManifest: parsePluginMd(
          `---\n${JSON.stringify({ ...definition.packageManifest.plugin, id: pluginId, contributes: { ...definition.packageManifest.plugin.contributes, data: { [namespace]: definition.packageManifest.plugin.contributes.data!.definitions! } } })}\n---`,
          "fixture/PLUGIN.md",
        ),
        loadedRuntimes: new Map(),
        status: "registered",
      });
      await registerDimensionProvider(registry);
      const value = {
        id: "world",
        definition: {
          kind: "phases",
          name: "Tide time",
          phases: ["Rise", "Fall"],
          cycleLabel: "Tide",
          initial: { cycle: 3, phase: 1 },
          evolution: { mode: "forward", defaultStep: 1, maxStep: 4 },
        },
      };
      const records = [
        { contract: "world.time-definition@1", key: "world", value },
      ];
      const llm = new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${JSON.stringify({ contractData: records })}\n===END===`,
      );
      const generate = vi.spyOn(llm, "generate");
      app = createTestApp(store, llm, registry);
      const response = await app.request("/api/ai/generate-world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: "A tidal city",
          saveTarget,
          brief: { contracts: ["world.time-definition@1"] },
        }),
      });
      const events = await readSseJson(response);
      const done = events.find((event) => event.type === "done") as
        { world: import("@covel/store").WorldRecord } | undefined;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(done?.world.metadata?.contractData).toEqual(records);
      expect(JSON.stringify(generate.mock.calls)).toContain(
        "world.time-definition@1",
      );
      if (saveTarget === "return-only") {
        expect(await store.getWorld("generated-world")).toBeNull();
        // Browser-private worlds sync the returned metadata through the world API.
        const created = await app.request("/api/worlds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: done!.world.id,
            name: "Tidal city",
            metadata: done!.world.metadata,
          }),
        });
        expect(created.status).toBe(201);
      }
      const now = new Date().toISOString();
      await store.createSession({
        id: "clock-session",
        worldId: "generated-world",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        locale: "en-US",
        activePlugins: ["world-init", pluginId],
        completedPlayerTurns: 0,
        createdAt: now,
        updatedAt: now,
      });
      const imported = await importWorldDataForSession({
        store,
        sessionId: "clock-session",
        worldId: "generated-world",
        worldsDirs: [worldsDir],
        now,
        preflight: { registry, activePlugins: ["world-init", pluginId] },
      });
      expect(
        imported.diagnostics.filter((item) => item.level === "error"),
      ).toEqual([]);
      expect(
        (
          await store.getPluginData(
            "clock-session",
            pluginId,
            namespace,
            "world",
          )
        )?.value,
      ).toEqual(value);
      expect(
        await store.getPluginData(
          "clock-session",
          pluginId,
          "clock",
          "current",
        ),
      ).toBeNull();
      if (saveTarget !== "server-file") {
        expect(await readdir(worldsDir)).toEqual([]);
        const preflight = await preflightWorldDataForSession({
          sessionId: "clock-session",
          worldId: "generated-world",
          contractData: records,
          now,
          preflight: { registry, activePlugins: ["world-init", pluginId] },
        });
        expect(preflight.targets).toContainEqual(
          expect.objectContaining({ pluginId, namespace, key: "world" }),
        );
        const world = (await store.getWorld("generated-world"))!;
        const updated = {
          ...value,
          definition: { ...value.definition, initial: { cycle: 8, phase: 0 } },
        };
        await store.upsertWorld({
          ...world,
          metadata: {
            ...world.metadata,
            contractData: [{ ...records[0], value: updated }],
          },
        });
        const clock = {
          schemaVersion: 1,
          definition: value.definition,
          tick: 7,
        };
        await store.setPluginData({
          id: "existing-clock",
          sessionId: "clock-session",
          pluginId,
          namespace: "clock",
          key: "current",
          value: clock,
          createdAt: now,
          updatedAt: now,
        });
        const sync = await syncWorldDataForSession({
          store,
          sessionId: "clock-session",
          worldId: "generated-world",
          now,
          preflight: { registry, activePlugins: ["world-init", pluginId] },
        });
        expect(sync.upserted).toBe(1);
        expect(
          (
            await store.getPluginData(
              "clock-session",
              pluginId,
              namespace,
              "world",
            )
          )?.value,
        ).toEqual(updated);
        expect(
          (
            await store.getPluginData(
              "clock-session",
              pluginId,
              "clock",
              "current",
            )
          )?.value,
        ).toEqual(clock);
      }
    },
  );

  it("cancels world generation on host shutdown without another provider attempt", async () => {
    const work = createApplicationWork();
    const started = Promise.withResolvers<AbortSignal>();
    const generate: LLMAdapter["generate"] = vi.fn(async ({ signal }) => {
      signal!.throwIfAborted();
      started.resolve(signal!);
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    });
    app = new Hono<Env>();
    app.use("*", work.middleware);
    app.route("/", createTestApp(store, { generate }));
    const response = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "Cancelled synthetic world",
        saveTarget: "server-file",
      }),
    });
    const body = response.text();
    const signal = await started.promise;
    await work.close();
    await body;
    expect(signal.aborted).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(await store.listWorlds()).toEqual([]);
    expect(await readdir(worldsDir)).toEqual([]);
  });

  it.each(["collision", "database-error"])(
    "cleans a newly generated package after %s without overwriting stored worlds",
    async (failure) => {
      if (failure === "collision") {
        await store.upsertWorld({
          id: "generated-world",
          name: "Original world",
          description: "Preserve me",
          createdAt: new Date().toISOString(),
        });
      } else {
        vi.spyOn(store, "createWorld").mockRejectedValueOnce(
          new Error("Synthetic database failure"),
        );
      }
      const before = await store.getWorld("generated-world");
      const generate = () =>
        app.request("/api/ai/generate-world", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            concept: "Synthetic world",
            saveTarget: "server-file",
          }),
        });
      const events = await readSseJson(await generate());
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(await store.getWorld("generated-world")).toEqual(before);
      expect(await readdir(worldsDir)).toEqual([]);
      if (failure === "database-error") {
        expect(
          (await readSseJson(await generate())).some(
            (event) => event.type === "done",
          ),
        ).toBe(true);
      }
    },
  );

  it.each([false, true])(
    "saves files in the user directory with explicit override=%s",
    async (explicitOverride) => {
      const bundledDir = path.join(worldsDir, "bundled");
      const userDir = path.join(
        worldsDir,
        explicitOverride ? "custom" : "worlds",
      );
      await mkdir(bundledDir);
      vi.stubEnv("COVEL_HOME", worldsDir);
      vi.stubEnv("COVEL_WORLDS_DIR", bundledDir);
      vi.stubEnv("COVEL_USER_WORLDS_DIR", explicitOverride ? userDir : "");

      const res = await app.request("/api/ai/generate-world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: "A clockwork city" }),
      });
      expect(res.status).toBe(200);
      const events = await readSseJson(res);
      const done = events.find((event) => event.type === "done");
      expect(done?.world.metadata.storage).toMatchObject({
        backend: "file",
        path: userDir,
      });
      expect(await readdir(userDir)).toEqual(["generated-world"]);
      expect(await readdir(bundledDir)).toEqual([]);
      expect(await store.getWorld("generated-world")).not.toBeNull();
    },
  );

  it("server-store saves generated worlds only in the configured DataStore", async () => {
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "生成世界",
        locale: "zh-CN",
        saveTarget: "server-store",
      }),
    });

    expect(res.status).toBe(200);
    const events = await readSseJson(res);
    const done = events.find((event) => event.type === "done");
    expect(done?.world.metadata.source).toBe("server-store");
    expect(done?.world.metadata.storage).toMatchObject({
      scope: "server",
      backend: "memory",
      durable: false,
    });
    expect(done?.world.metadata.worldDataPath).toBeUndefined();
    expect(await store.getWorld("generated-world")).toMatchObject({
      id: "generated-world",
      metadata: {
        source: "server-store",
      },
    });
  });

  it("return-only does not save generated worlds to the server store", async () => {
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "生成世界",
        locale: "zh-CN",
        saveTarget: "return-only",
      }),
    });

    expect(res.status).toBe(200);
    const events = await readSseJson(res);
    const done = events.find((event) => event.type === "done");
    expect(done?.world.metadata.storage).toMatchObject({
      scope: "transient",
      backend: "response",
      durable: false,
    });
    expect(await store.getWorld("generated-world")).toBeNull();
  });

  it("keeps return-only generation public in production browser-private mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "Local preview",
        saveTarget: "return-only",
      }),
    });

    expect(res.status).toBe(200);
    const events = await readSseJson(res);
    expect(events.find((event) => event.type === "done")?.world).toMatchObject({
      id: "generated-world",
      metadata: { storage: { scope: "transient", backend: "response" } },
    });
    expect(await store.listWorlds()).toEqual([]);
    expect(await readdir(worldsDir)).toEqual([]);
  });

  it("allows an operator to persist a generated world in production browser-private mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-world-operator");
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-world-operator",
      },
      body: JSON.stringify({
        concept: "Shared world",
        saveTarget: "server-store",
      }),
    });

    expect(res.status).toBe(200);
    const events = await readSseJson(res);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(await store.getWorld("generated-world")).toMatchObject({
      id: "generated-world",
      metadata: { source: "server-store" },
    });
  });

  it("embeds requested text supplements for store-only worlds without dangling paths", async () => {
    app = createTestApp(
      store,
      new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`,
      ),
    );
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "生成完整钟城",
        locale: "zh-CN",
        saveTarget: "server-store",
        brief: {
          experienceMode: "traditional-story",
          content: ["characters", "lorebook", "rules"],
        },
      }),
    });

    expect(res.status).toBe(200);
    const events = await readSseJson(res);
    const done = events.find((event) => event.type === "done");
    expect(done?.world.metadata).toMatchObject({
      source: "server-store",
      characterBlueprints: expect.arrayContaining([
        expect.objectContaining({ id: "keeper" }),
      ]),
      embeddedLorebook: expect.arrayContaining([
        expect.objectContaining({ id: "time-cost" }),
      ]),
      generatedPackageSummary: {
        characters: 3,
        lorebook: 4,
        rules: 3,
      },
    });
    expect(done?.world.metadata.worldDataPath).toBeUndefined();
    expect(done?.world.metadata.characterBlueprintSources).toBeUndefined();
  });

  it("returns a world that falls short of the brief, with warnings", async () => {
    const lorebook = [
      { id: "tide-calendar", content: "The tide follows the calendar." },
      { id: "clock-tower", content: "The tower keeps the tide log." },
    ];
    app = createTestApp(
      store,
      new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${JSON.stringify({ lorebook })}\n===END===`,
      ),
    );
    const response = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "A tidal city",
        saveTarget: "return-only",
        brief: { content: ["lorebook"] },
      }),
    });
    const events = await readSseJson(response);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.find((event) => event.type === "done")).toMatchObject({
      warnings: ["generated 2 lorebook entries; the brief asks for 4"],
    });
  });

  it("rejects a plugin contract that no loaded plugin offers for generation", async () => {
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "生成世界",
        brief: { contracts: ["not-offered@1"] },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("brief.contracts"),
    });
  });

  it("rejects unsupported world-package content options before streaming", async () => {
    const res = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "生成世界",
        brief: {
          experienceMode: "traditional-story",
          content: ["characters", "unknown-content"],
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("brief.content"),
    });
  });

  it("reports every part of the world while it is generated", async () => {
    app = createTestApp(
      store,
      new FixedLlm(
        `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`,
      ),
    );
    const response = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "Clockwork city",
        saveTarget: "return-only",
        brief: { content: ["characters", "rules"] },
      }),
    });
    const events = await readSseJson(response);
    expect(events.filter((event) => event.type === "error")).toEqual([]);

    const reports = events.flatMap((event) =>
      Array.isArray(event.parts)
        ? [event.parts as { id: string; state: string }[]]
        : [],
    );
    expect(reports[0]!.map((part) => [part.id, part.state])).toEqual([
      ["manifest", "pending"],
      ["lore", "pending"],
      ["characters", "pending"],
      ["rules", "pending"],
    ]);
    expect(reports.at(-1)!.map((part) => part.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    // The parts are reported before the world is checked and saved.
    const types = events.map((event) =>
      event.type === "progress" ? event.phase : event.type,
    );
    expect(types.lastIndexOf("generating")).toBeLessThan(
      types.indexOf("validating"),
    );
    expect(types.at(-1)).toBe("done");
  });

  it("tells the client when the model stayed silent for the idle timeout", async () => {
    const create = vi.spyOn(worldCreation, "createWorld").mockResolvedValue({
      success: false,
      id: "unknown",
      errors: ["LLM error: The model sent no output for 300 seconds"],
      idleTimeout: true,
    });
    const response = await app.request("/api/ai/generate-world", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        concept: "Clockwork city",
        saveTarget: "return-only",
        idleTimeoutMs: 300_000,
      }),
    });

    expect(await readSseJson(response)).toContainEqual({
      type: "error",
      message: "LLM error: The model sent no output for 300 seconds",
      code: "model_idle_timeout",
    });
    expect(create.mock.calls[0]![0].idleTimeoutMs).toBe(300_000);
  });

  it.each([999, 1_800_001, 60_000.5, "60000"])(
    "rejects the idle timeout %s before streaming",
    async (idleTimeoutMs) => {
      for (const [route, body] of [
        ["generate-world", { concept: "Clockwork city" }],
        ["revise-world", { worldId: "any", instruction: "加一个派系" }],
      ] as const) {
        const res = await app.request(`/api/ai/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, idleTimeoutMs }),
        });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          error: "idleTimeoutMs must be an integer from 1000 to 1800000",
        });
      }
    },
  );

  /**
   * A player changes a world made in the app with one request. The model
   * gets the world as it is and writes back only what the request touches.
   */
  describe("revision", () => {
    const FULL = `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${WORLD_MD}\n===WORLD_PACKAGE_YAML===\n${WORLD_PACKAGE_YAML}\n===END===`;
    const REVISED_MD = `${WORLD_MD}\n4. 抢在对手校时官之前找到备用钟芯。`;
    const REVISED = `===WORLD_YAML===\nUNCHANGED\n===WORLD_MD===\n${REVISED_MD}\n===WORLD_PACKAGE_YAML===\nUNCHANGED\n===END===`;
    // A new world is one request for each part: the manifest, the lore and
    // the three lists of the brief. Each request takes its section from the
    // answer it gets.
    const CREATED = [FULL, FULL, FULL, FULL, FULL];

    /** Answers in order, and keeps what it was asked. */
    class SequenceLlm implements LLMAdapter {
      readonly requests: string[] = [];
      constructor(private readonly answers: readonly string[]) {}
      async generate(request: {
        messages: readonly { role: string; content: unknown }[];
      }): Promise<LLMResponse> {
        this.requests.push(
          request.messages.map((message) => String(message.content)).join("\n"),
        );
        return {
          content: this.answers[this.requests.length - 1] ?? "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    }

    const post = (route: string, body: object) =>
      app.request(`/api/ai/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const worldOf = async (response: Response) => {
      const events = await readSseJson(response);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      return events.find((event) => event.type === "done")?.world as {
        id: string;
        lore: string;
        createdAt: string;
        metadata: Record<string, unknown>;
      };
    };
    const generate = async (saveTarget: string, llm: LLMAdapter) => {
      app = createTestApp(store, llm);
      return worldOf(
        await post("generate-world", {
          concept: "Clockwork city",
          saveTarget,
          brief: { content: ["characters", "lorebook", "rules"] },
        }),
      );
    };

    it("rewrites the package of a world that has files, and keeps what the request did not touch", async () => {
      const llm = new SequenceLlm([...CREATED, REVISED]);
      const created = await generate("server-file", llm);

      const revised = await worldOf(
        await post("revise-world", {
          worldId: created.id,
          instruction: "加一个与对手校时官有关的冒险钩子",
        }),
      );

      expect(revised.id).toBe("generated-world");
      expect(revised.lore).toBe(REVISED_MD);
      expect(revised.createdAt).toBe(created.createdAt);
      // The model was given the world as it is, read from its files.
      const request = llm.requests[CREATED.length];
      expect(request).toContain("加一个与对手校时官有关的冒险钩子");
      expect(request).toContain("守钟人");
      expect(request).toContain("改写时间必须失去记忆");
      // On disk: the new lore, the same cast, and nothing beside the package.
      const dir = path.join(worldsDir, "generated-world");
      expect(await readFile(path.join(dir, "WORLD.md"), "utf8")).toBe(
        REVISED_MD,
      );
      expect(
        JSON.parse(
          await readFile(path.join(dir, "characters/characters.json"), "utf8"),
        ).map((item: { id: string }) => item.id),
      ).toEqual(["keeper", "courier", "thief"]);
      expect(await readdir(worldsDir)).toEqual(["generated-world"]);
      expect((await store.getWorld("generated-world"))?.lore).toBe(REVISED_MD);
    });

    it("keeps the lists and manifest fields that the model did not write again", async () => {
      // The model answers "add a character" with the new character alone.
      const cast = `characters:
  - { schemaVersion: 1, id: rival, name: 对手校时官, role: npc }`;
      const created = await generate(
        "server-file",
        new SequenceLlm([
          ...CREATED,
          `===WORLD_YAML===\nUNCHANGED\n===WORLD_MD===\nUNCHANGED\n===WORLD_PACKAGE_YAML===\n${cast}\n===END===`,
        ]),
      );

      const revised = await worldOf(
        await post("revise-world", {
          worldId: created.id,
          instruction: "加一个对手角色",
        }),
      );

      const dir = path.join(worldsDir, "generated-world");
      expect(revised.metadata.generatedPackageSummary).toEqual({
        characters: 4,
        lorebook: 4,
        rules: 3,
      });
      // The lore entries and rules are still in the package.
      expect(
        await readFile(path.join(dir, "data/lorebook.yaml"), "utf8"),
      ).toContain("改写时间必须失去记忆");
      // So is a field of world.yaml that the world record does not hold.
      expect(await readFile(path.join(dir, "world.yaml"), "utf8")).toContain(
        "version: 0.1.0",
      );
    });

    it("revises a world that lives in the store without writing files", async () => {
      await generate("server-store", new SequenceLlm([...CREATED, REVISED]));

      const revised = await worldOf(
        await post("revise-world", {
          worldId: "generated-world",
          instruction: "加一个钩子",
        }),
      );

      expect(revised.lore).toBe(REVISED_MD);
      expect(revised.metadata.characterBlueprints).toHaveLength(3);
      expect((await store.getWorld("generated-world"))?.lore).toBe(REVISED_MD);
      expect(await readdir(worldsDir)).toEqual([]);
    });

    it("revises a world that only the browser holds and stores nothing", async () => {
      const local = await generate(
        "return-only",
        new SequenceLlm([...CREATED, REVISED]),
      );
      expect(await store.getWorld("generated-world")).toBeNull();

      const revised = await worldOf(
        await post("revise-world", {
          worldId: local.id,
          instruction: "加一个钩子",
          world: local,
        }),
      );

      expect(revised.lore).toBe(REVISED_MD);
      expect(revised.metadata.characterBlueprints).toHaveLength(3);
      expect(await store.getWorld("generated-world")).toBeNull();
      expect(await readdir(worldsDir)).toEqual([]);
    });

    it("does not rewrite a world package that the generator did not write", async () => {
      // An installed package is `generated-file` too, and holds media and
      // sources that a rewrite would lose. Only the generator's mark counts.
      for (const [id, source] of [
        ["bundled-world", "file"],
        ["installed-world", "generated-file"],
      ] as const) {
        await store.createWorld({
          id,
          name: "A package",
          description: "A world package.",
          metadata: { source },
          createdAt: new Date().toISOString(),
        });
        const response = await post("revise-world", {
          worldId: id,
          instruction: "加一个派系",
        });
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          code: "world_not_revisable",
        });
      }
    });

    it("knows a generated package again after the world is loaded from disk", async () => {
      await generate("server-file", new SequenceLlm(CREATED));
      // What a restart does: the record comes from the files alone.
      const reloaded = await loadSingleWorld(
        path.join(worldsDir, "generated-world"),
      );
      expect(reloaded?.metadata).toMatchObject({
        source: "file",
        generated: true,
      });
    });

    it("asks for a world and a request", async () => {
      expect((await post("revise-world", { worldId: "x" })).status).toBe(400);
      expect(
        (await post("revise-world", { instruction: "加一个派系" })).status,
      ).toBe(400);
      expect(
        (await post("revise-world", { worldId: "missing", instruction: "x" }))
          .status,
      ).toBe(404);
    });
  });
});
