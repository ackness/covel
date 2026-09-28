import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createGateway,
  createProviderRegistry,
  createPresetRegistry,
} from "@covel/ai-provider";
import { createSqliteStore } from "@covel/store/sqlite";
import { createMemorySystem } from "@covel/memory";
import {
  createMemoryEmbed,
  createEmbeddingLockHelper,
} from "../src/embedding-lock.js";
import type { AiStack } from "../src/ai-setup.js";

it("rejects same-dimension model drift after restart for ingestion and both queries", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-embedding-identity-"),
  );
  const dbPath = path.join(root, "test.db");
  let store = createSqliteStore(dbPath);
  const now = "2026-01-01T00:00:00.000Z";
  const calls: string[] = [];
  const makeAi = (model: string) => {
    const providerRegistry = createProviderRegistry({
      providers: {
        test: {
          adapter: {
            generateText: async () => {
              throw new Error("unused");
            },
            generateObject: async () => {
              throw new Error("unused");
            },
            async *streamText() {
              throw new Error("unused");
            },
            embed: async (_config, input) => {
              calls.push(model);
              return {
                embeddings: input.values.map(() =>
                  model === "old" ? [1, 0] : [0, 1],
                ),
                usage: { inputTokens: 1, outputTokens: 0 },
              };
            },
          },
          defaults: { baseUrl: "https://test.invalid" },
        },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles: [
        {
          id: "embed-default",
          tier: "embed-default",
          provider: "test",
          model,
          contextWindow: 8192,
          latencyClass: "low",
          costClass: "low",
          supportedModes: ["embed"],
        },
      ],
      presets: [],
    });
    return {
      gateway: createGateway({ providerRegistry, presetRegistry }),
      presetRegistry,
    } as unknown as AiStack;
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await store.createSession({
      id: "session",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    });
    const oldAi = makeAi("old");
    await createEmbeddingLockHelper({ store, ai: oldAi })("session");
    await store.appendTurnMessage({
      id: "first",
      sessionId: "session",
      turnId: "turn",
      sourceType: "player",
      role: "user",
      content: "historical dragon",
      order: 1,
      createdAt: now,
    });
    await store.upsertLorebookEntries([
      {
        id: "lore",
        sessionId: "session",
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
    await createMemorySystem({
      store,
      embed: createMemoryEmbed({ ai: oldAi }),
    }).ingest("session");
    expect(calls).toEqual(["old", "old", "old"]);
    await store.close();
    store = createSqliteStore(dbPath);
    const newAi = makeAi("new");
    await createEmbeddingLockHelper({ store, ai: newAi })("session");
    await store.appendTurnMessage({
      id: "second",
      sessionId: "session",
      turnId: "turn-new",
      sourceType: "player",
      role: "user",
      content: "recent dragon",
      order: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const memory = createMemorySystem({
      store,
      embed: createMemoryEmbed({ ai: newAi }),
    });
    const search = vi.spyOn(store, "searchVectors");
    await memory.ingest("session");
    expect(
      (await memory.recall.search("session", "dragon")).length,
    ).toBeGreaterThan(0);
    expect(
      (await memory.archival.search("session", "dragon")).length,
    ).toBeGreaterThan(0);
    expect(search).not.toHaveBeenCalled();
    expect(calls).toEqual(["old", "old", "old"]);
    expect((await store.resolveSessionVectorTarget!("session"))?.modelId).toBe(
      "test/old",
    );
    search.mockRestore();
    const vectors = await store.searchVectors!({
      sessionId: "session",
      query: new Float32Array([1, 0]),
      topK: 10,
    });
    expect(vectors).toHaveLength(2);
    // Restoring the locked identity catches up without losing the failed cursor.
    await createMemorySystem({
      store,
      embed: createMemoryEmbed({ ai: oldAi }),
    }).ingest("session");
    expect(
      await store.searchVectors!({
        sessionId: "session",
        query: new Float32Array([1, 0]),
        topK: 10,
      }),
    ).toHaveLength(3);
  } finally {
    warn.mockRestore();
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
