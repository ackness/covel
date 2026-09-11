import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { MemorySystem } from "@covel/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";

it.each(["none", "embedded"] as const)(
  "honors vector backend %s for model locks, ingestion and recall",
  async (vectorBackend) => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "covel-vector-config-"));
    try {
      const store = createMemoryStore();
      const now = new Date().toISOString();
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
      const target = await store.ensureVectorModel!({
        provider: "test",
        modelName: "embed",
        modelId: "test/embed",
        dim: 8,
      });
      await store.lockSessionEmbeddingModel!("session", target);
      await store.appendTurnMessage({
        id: "message",
        sessionId: "session",
        turnId: "turn",
        sourceType: "player",
        role: "user",
        content: "A clue at the harbor",
        order: 1,
        createdAt: now,
      });
      const embed = vi.fn(async (texts: readonly string[]) =>
        texts.map(() => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])),
      );
      const lock = vi.fn(async () => undefined);
      let memory: MemorySystem | undefined;
      let injectedLock: unknown;
      const { app } = await bootstrapApi({
        pluginsDir,
        store,
        storeBackend: "memory",
        vectorBackend,
        llmAdapter: { generate: vi.fn() },
        memoryEmbed: embed,
        ensureEmbeddingLock: lock,
        perRequestMiddleware: [
          async (c, next) => {
            memory = c.get("memorySystem");
            injectedLock = c.get("ensureEmbeddingLock");
            await next();
          },
        ],
      });
      expect((await app.request("/api/health")).status).toBe(200);
      expect(memory).toBeDefined();
      await memory!.ingest("session");
      const recalled = await memory!.recall.search("session", "harbor", 5);
      expect(recalled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "A clue at the harbor" }),
        ]),
      );
      if (vectorBackend === "none") {
        expect(injectedLock).toBeUndefined();
        expect(embed).not.toHaveBeenCalled();
      } else {
        expect(injectedLock).toBe(lock);
        expect(embed).toHaveBeenCalledTimes(2);
      }
    } finally {
      await rm(pluginsDir, { recursive: true, force: true });
    }
  },
);
