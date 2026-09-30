import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import { createSqliteStore } from "@covel/store/sqlite";
import { createMemorySystem } from "@covel/memory";
import {
  createGatewayAdapter,
  createPluginRuntimeGateway,
} from "@covel/runtime";
import {
  createEmbeddingLockHelper,
  createMemoryEmbed,
  embeddingModelIdentity,
} from "../src/embedding-lock.js";
import { createPerRequestLlmMiddleware } from "../src/middleware/per-request-llm.js";
import type { AiStack } from "../src/ai-setup.js";

const header = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

it("uses request embedding settings and keys for probes and detached work without mixing pinned vector spaces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-request-embed-"));
  const store = createSqliteStore(path.join(root, "store.db"));
  const embed = vi.fn<ModelProviderAdapter["embed"]>(async (config, input) => ({
    embeddings: input.values.map(() =>
      config.baseUrl?.includes("other") ? [1, 2, 3] : [1, 2],
    ),
    usage: { inputTokens: 1, outputTokens: 0 },
  }));
  const providerRegistry = createProviderRegistry({
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
  });
  const presetRegistry = createPresetRegistry({
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
  });
  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({
    slots: {
      embed: { slotId: "embed", presetId: "base-embed", tag: "embedding" },
    },
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const ai = { gateway, presetRegistry, slotRegistry } as unknown as AiStack;
  const lock = createEmbeddingLockHelper({
    store,
    ai,
    apiKeys: { test: "env-key" },
  });
  const memoryEmbed = createMemoryEmbed({ ai, apiKeys: { test: "env-key" } });
  const memory = createMemorySystem({ store, embed: memoryEmbed });
  const jobs: Promise<unknown>[] = [];
  const app = new Hono();
  app.use(
    "*",
    createPerRequestLlmMiddleware({
      ai,
      envApiKeys: { test: "env-key" },
      defaultLlmAdapter: createGatewayAdapter(gateway),
      defaultPluginGateway: createPluginRuntimeGateway(gateway),
    }),
  );
  app.post("/:id", async (c) => {
    const sessionId = c.req.param("id");
    await lock(sessionId);
    const target = await store.resolveSessionVectorTarget!(sessionId);
    if (!target) return c.json({ error: "not locked" }, 500);
    // Deferred ingestion runs after the response but inherits the originating scope.
    jobs.push(
      new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
        await memoryEmbed(["ingest"], { sessionId, modelId: target.modelId });
        await memory.ingest(sessionId);
        expect(
          (await memory.recall.search(sessionId, "dragon")).length,
        ).toBeGreaterThan(0);
        expect(
          (await memory.archival.search(sessionId, "dragon")).length,
        ).toBeGreaterThan(0);
      }),
    );
    return c.json({ modelId: target.modelId, dim: target.dim });
  });
  const requestConfig = (baseUrl: string) => ({
    slotBindings: { embed: { modelRef: "ui-embedding" } },
    customPresets: [
      {
        id: "ui-embedding",
        name: "UI Embed",
        provider: "test",
        model: "ui-model",
        protocol: "openai-chat-v1",
        baseUrl,
      },
    ],
    capabilityOverrides: { embed: { output: ["embedding"] } },
  });
  const headers = (key: string, baseUrl: string) => ({
    "X-Provider-Keys": header({ test: key }),
    "X-Slot-Config": header(requestConfig(baseUrl)),
  });
  const now = "2026-01-01T00:00:00.000Z";
  try {
    for (const id of ["first", "second"]) {
      await store.createSession({
        id,
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [],
        createdAt: now,
        updatedAt: now,
      });
      await store.appendTurnMessage({
        id: `${id}-message`,
        sessionId: id,
        turnId: `${id}-turn`,
        sourceType: "player",
        role: "user",
        content: "historical dragon",
        order: 1,
        createdAt: now,
      });
      await store.upsertLorebookEntries([
        {
          id: `${id}-lore`,
          sessionId: id,
          owner: { kind: "world" },
          keys: ["dragon"],
          content: "dragon lore",
          strategy: "selective",
          position: "before",
          insertionOrder: 0,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    const responses = await Promise.all([
      app.request("/first", {
        method: "POST",
        headers: headers("first-key", "https://ui.example/v1"),
      }),
      app.request("/second", {
        method: "POST",
        headers: headers("second-key", "https://other.example/v1"),
      }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    await Promise.all(jobs);
    expect(embed.mock.calls).toHaveLength(12);
    expect(
      embed.mock.calls
        .filter(([config]) => config.apiKey === "first-key")
        .map(([config, input]) => [config.baseUrl, input.model]),
    ).toEqual(
      Array.from({ length: 6 }, () => ["https://ui.example/v1", "ui-model"]),
    );
    expect(
      embed.mock.calls.filter(([config]) => config.apiKey === "second-key"),
    ).toHaveLength(6);
    const first = await store.resolveSessionVectorTarget!("first");
    const second = await store.resolveSessionVectorTarget!("second");
    expect(first?.dim).toBe(2);
    expect(second?.dim).toBe(3);
    expect(first?.modelId).not.toBe(second?.modelId);
    expect(JSON.stringify(first)).not.toContain("first-key");
    // Changed endpoint/model settings cannot emit vectors into the earlier index.
    jobs.length = 0;
    await app.request("/first", {
      method: "POST",
      headers: headers("new-key", "https://other.example/v1"),
    });
    await expect(jobs[0]).rejects.toThrow("Embedding configuration changed");
    expect(embed.mock.calls).toHaveLength(12);
    // The immutable lock and request overlay never change process defaults.
    expect((await store.resolveSessionVectorTarget!("first"))?.modelId).toBe(
      first?.modelId,
    );
    expect(
      gateway.resolveSlot(undefined, { fallbackTag: "embedding" })?.model,
    ).toBe("base-model");
    expect(
      embeddingModelIdentity(
        gateway.resolveSlot(undefined, { fallbackTag: "embedding" })!,
      ),
    ).not.toBe(first?.modelId);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
