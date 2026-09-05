import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore, type DataStore } from "@covel/store";
import { aiRoutes } from "../../src/routes/api/ai.js";

const WORLD_YAML = `schemaVersion: "1.0"
id: generated-world
name: 生成世界
version: "0.1.0"
summary: 一个生成世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [test]
requiredPlugins: []
recommendedPlugins: []
dimensions:
  geography:
    regions:
      - name: 中央区
        description: 核心区域。
        climate: 温和
  tone:
    genres: [mystery]
    contentRating: teen
  startingConditions:
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
): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("llmAdapter", llm);
    c.set("store", store);
    c.set("storeBackend", "memory");
    await next();
  });
  app.route("/api/ai", aiRoutes);
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
  let store: DataStore;
  let app: Hono<Env>;
  let worldsDir: string;
  const previousStoreBackend = process.env.STORE_BACKEND;
  const previousUserWorldsDir = process.env.COVEL_USER_WORLDS_DIR;
  const previousWorldsDir = process.env.COVEL_WORLDS_DIR;

  beforeEach(async () => {
    store = createMemoryStore();
    app = createTestApp(store);
    worldsDir = await mkdtemp(path.join(tmpdir(), "covel-ai-worlds-"));
    await mkdir(worldsDir, { recursive: true });
    process.env.STORE_BACKEND = "memory";
    process.env.COVEL_USER_WORLDS_DIR = worldsDir;
    delete process.env.COVEL_WORLDS_DIR;
  });

  afterEach(() => {
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
  });

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
});
