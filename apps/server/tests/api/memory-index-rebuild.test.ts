import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
} from "@covel/runtime";
import { createMemorySystem, type MemorySystem } from "@covel/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { SessionMemoryIndexStatus } from "@covel/shared";
import type { DataStore, VectorStore } from "@covel/store";
import {
  createEmbeddingLockHelper,
  createMemoryEmbed,
  createMemoryIndexControl,
} from "../../src/embedding-lock.js";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { registerSessionMemoryIndexRoutes } from "../../src/routes/api/session/memory-index-route.js";
import type { SessionRouteEnv } from "../../src/routes/api/session/route-env.js";
import type { AiStack } from "../../src/ai-setup.js";

const header = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

/** A turn's model settings: the embedding slot bound to another endpoint. */
const otherModel = (key: string) => ({
  "X-Provider-Keys": header({ test: key }),
  "X-Slot-Config": header({
    slotBindings: { embed: { modelRef: "ui-embedding" } },
    customPresets: [
      {
        id: "ui-embedding",
        name: "UI Embed",
        provider: "test",
        model: "ui-model",
        protocol: "openai-chat-v1",
        baseUrl: "https://other.example/v1",
      },
    ],
    capabilityOverrides: { embed: { output: ["embedding"] } },
  }),
});

let root: string;
let store: DataStore & VectorStore;
let memory: MemorySystem;
let app: Hono<SessionRouteEnv>;
let lock: (sessionId: string) => Promise<void>;
let embed: ReturnType<typeof vi.fn<ModelProviderAdapter["embed"]>>;
const now = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-memory-index-"));
  store = createSqliteStore(path.join(root, "store.db")) as DataStore &
    VectorStore;
  embed = vi.fn<ModelProviderAdapter["embed"]>(async (config, input) => {
    if (config.apiKey === "bad-key") throw new Error("401 invalid key");
    return {
      embeddings: input.values.map(() =>
        config.baseUrl?.includes("other") ? [1, 2, 3] : [1, 2],
      ),
      usage: { inputTokens: 1, outputTokens: 0 },
    };
  });
  const gateway = createGateway({
    providerRegistry: createProviderRegistry({
      providers: {
        test: {
          adapter: {
            generateText: vi.fn(),
            generateObject: vi.fn(),
            streamText: vi.fn(),
            embed,
          } as ModelProviderAdapter,
          defaults: {
            baseUrl: "https://trusted.example/v1",
            protocol: "openai-chat-v1",
          },
        },
      },
    }),
    presetRegistry: createPresetRegistry({
      profiles: [],
      presets: [
        {
          id: "base-embed",
          name: "Base",
          provider: "test",
          model: "base-model",
          protocol: "openai-chat-v1",
          supportedModes: ["embed"],
          tier: "medium",
          enabled: true,
          capability: { input: ["text"], output: ["embedding"] },
        },
      ],
    }),
    slotRegistry: (() => {
      const slots = createSlotRegistry();
      slots.configure({
        slots: {
          embed: { slotId: "embed", presetId: "base-embed", tag: "embedding" },
        },
      });
      return slots;
    })(),
  });
  const ai = { gateway } as unknown as AiStack;
  const apiKeys = { test: "env-key" };
  lock = createEmbeddingLockHelper({ store, ai, apiKeys });
  memory = createMemorySystem({
    store,
    embed: createMemoryEmbed({ ai, apiKeys }),
  });
  const memoryIndex = createMemoryIndexControl({ store, ai, apiKeys });
  const memoryIngestLock = createInProcessSessionLock();
  app = new Hono<SessionRouteEnv>();
  app.use(
    "*",
    createPerRequestLlmMiddleware({
      ai,
      envApiKeys: apiKeys,
      defaultLlmAdapter: createGatewayAdapter(gateway),
      defaultPluginGateway: createPluginRuntimeGateway(gateway),
    }),
  );
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("memoryIndex", memoryIndex);
    c.set("memorySystem", memory);
    c.set("memoryIngestLock", memoryIngestLock);
    await next();
  });
  const routes = new Hono<SessionRouteEnv>();
  registerSessionMemoryIndexRoutes(routes);
  app.route("/api/sessions", routes);

  for (const id of ["s", "keep"]) {
    await store.createSession({
      id,
      status: "active",
      locale: "en",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: [],
      metadata: {
        sessionIncarnationNonce: `${id}-nonce`,
        approvalScopeNonce: `${id}-scope`,
      },
      createdAt: now,
      updatedAt: now,
    });
    await store.appendTurnMessage({
      id: `${id}-message`,
      sessionId: id,
      turnId: `${id}-turn`,
      sourceType: "player",
      role: "user",
      content: "the dragon sleeps",
      order: 1,
      createdAt: now,
    });
    // Indexed with the model the server was configured with at the time.
    await lock(id);
    await memory.ingest(id);
  }
});

afterEach(async () => {
  await memory.drain();
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const status = async (headers?: Record<string, string>) => {
  const response = await app.request("/api/sessions/s/memory-index", {
    headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SessionMemoryIndexStatus;
};

const indexed = (sessionId: string, dim: number) =>
  store.searchVectors({
    sessionId,
    query: new Float32Array(Array.from({ length: dim }, (_, i) => i + 1)),
    topK: 10,
  });

it("reports the session's index as stale when the turn's model settings select another model", async () => {
  expect(await status()).toEqual({
    available: true,
    locked: expect.objectContaining({
      provider: "test",
      modelName: "base-model",
      dim: 2,
    }),
    configured: { provider: "test", modelName: "base-model" },
    stale: false,
  });
  expect(await status(otherModel("ui-key"))).toMatchObject({
    locked: { modelName: "base-model" },
    configured: { provider: "test", modelName: "ui-model" },
    stale: true,
  });
});

it("rebuilds the index with the configured model and reclaims the old vectors", async () => {
  const before = (await store.resolveSessionVectorTarget("s"))!;
  expect(await indexed("s", 2)).toHaveLength(1);

  const response = await app.request("/api/sessions/s/memory-index/rebuild", {
    method: "POST",
    headers: otherModel("ui-key"),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    locked: { modelName: "ui-model", dim: 3 },
    stale: false,
  });
  await memory.drain();

  const after = (await store.resolveSessionVectorTarget("s"))!;
  expect(after.modelRegistryId).not.toBe(before.modelRegistryId);
  // The background sweep filled the new index from the first message.
  expect((await indexed("s", 3)).map((row) => row.key)).toContain("s-message");
  // The other session keeps its index under the old model.
  expect(await indexed("keep", 2)).toHaveLength(1);

  // Moving back to the first model finds none of the old rows left.
  await store.resetSessionVectorIndex({
    sessionId: "s",
    expectedSessionCreatedAt: now,
    expectedModelRegistryId: after.modelRegistryId,
    target: before,
  });
  expect(await indexed("s", 2)).toEqual([]);
});

it("keeps the old index when the new model does not answer", async () => {
  const before = await store.resolveSessionVectorTarget("s");
  const response = await app.request("/api/sessions/s/memory-index/rebuild", {
    method: "POST",
    headers: otherModel("bad-key"),
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: "embedding_unavailable",
  });
  expect(await store.resolveSessionVectorTarget("s")).toEqual(before);
  expect(await indexed("s", 2)).toHaveLength(1);
});

it("keeps the old index when the selected model cannot serve the embedding role", async () => {
  const before = await store.resolveSessionVectorTarget("s");
  const response = await app.request("/api/sessions/s/memory-index/rebuild", {
    method: "POST",
    headers: {
      "X-Slot-Config": header({
        slotBindings: { embed: { modelRef: "text-only" } },
        customPresets: [
          {
            id: "text-only",
            name: "Text only",
            provider: "test",
            model: "text-model",
            protocol: "openai-chat-v1",
          },
        ],
        capabilityOverrides: { embed: { output: ["text"] } },
      }),
    },
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: "embedding_unavailable",
  });
  expect(await store.resolveSessionVectorTarget("s")).toEqual(before);
  expect(await indexed("s", 2)).toHaveLength(1);
});
