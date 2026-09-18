import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

describe("resume commit composition", () => {
  it.each([true, false])(
    "publishes exports with media ownership enforced (owned=%s)",
    async (owned) => {
      const store = createMemoryStore();
      const now = new Date().toISOString();
      await store.createSession({
        id: "session",
        worldId: null,
        presetId: null,
        status: "active",
        phase: "playing",
        completedPlayerTurns: 2,
        setupRuntimes: {},
        activePlugins: ["producer"],
        metadata: {
          approvalScopeNonce: "approval-test",
          sessionIncarnationNonce: "session-test",
        },
        locale: "en",
        createdAt: now,
        updatedAt: now,
      });
      const manifest = {
        name: "producer",
        pluginId: "producer",
        pluginType: "plugin",
        version: "1.0.0",
        description: "Resumed export producer",
        stage: "narrative",
        trigger: { type: "manual" },
        runtimeType: "function",
        outputKind: "story",
        output: { recordAs: "story", schema: "./output.json" },
      } as RuntimeManifest;
      const pluginRegistry = createPluginRegistry();
      pluginRegistry.register({
        id: "producer",
        source: "builtin",
        status: "registered",
        loadedRuntimes: new Map(),
        summary: {
          id: "producer",
          name: "Producer",
          description: "",
          pluginType: "plugin",
          runtimeCount: 1,
        },
        manifests: [{ manifest, promptTemplate: "", rawFrontmatter: {} }],
      });
      await store.saveSuspension({
        id: "suspension",
        sessionId: "session",
        turnId: "turn",
        runtimeId: "producer",
        pluginId: "producer",
        reason: "input",
        resumeSchema: {},
        createdAt: now,
        pendingContinuation: {
          executionContext: {
            executionId: "original-run",
            origin: "manual",
            countPolicy: "none",
          },
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
        },
      });
      const assetId = "a".repeat(64);
      const value = {
        narrativeOutput: "The journey continues.",
        portrait: {
          id: assetId,
          mime: "image/png",
          size: 42,
          url: "https://example.com/transient",
        },
      };
      const loadRuntime = vi.fn(async () => ({
        manifest,
        promptTemplate: "",
        outputSchema: {
          type: "object",
          required: ["narrativeOutput", "portrait"],
          properties: {
            narrativeOutput: { type: "string" },
            portrait: { type: "object" },
          },
        },
        handler: async () => ({ outcome: "success", value }),
      }));
      const isReferencedBy = vi.fn(async () => owned);
      const updateAfterTurn = vi.fn(async () => ({
        updated: true,
        blocksChanged: [],
      }));
      const events: string[] = [];
      const eventBus = createEventBus();
      eventBus.onEmit((event) => events.push(event.type));
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", pluginRegistry);
        c.set("sessionLock", createInProcessSessionLock());
        c.set("eventBus", eventBus);
        c.set("loadRuntimeFn", loadRuntime);
        c.set("getPluginSource", () => "builtin");
        c.set("llmAdapter", {
          generate: async () => {
            throw new Error("function must not use LLM");
          },
        });
        c.set("mediaStore", {
          lookup: async () => ({ mime: "image/png", size: 42 }),
          isReferencedBy,
        });
        c.set("memorySystem", {
          manager: {
            loadBlocks: async () => [
              { label: "scene", content: "Before resume", updatedAt: now },
            ],
            initializeDefaults: async () => {},
          },
          updater: { updateAfterTurn },
        });
        await next();
      });
      app.route("/api/sessions", resumeRoutes);
      const response = await app.request(
        "/api/sessions/session/suspensions/suspension/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: {} }),
        },
      );
      expect(response.status, await response.text()).toBe(200);
      const exports = await store.listRuntimeExports("session");
      expect(exports).toHaveLength(owned ? 1 : 0);
      if (owned)
        expect(exports[0].value).toEqual({
          ...value,
          portrait: { id: assetId, mime: "image/png", size: 42 },
        });
      expect(isReferencedBy).toHaveBeenCalledWith(assetId, "session");
      expect(
        (await store.getSuspension("suspension"))?.resolvedAt,
      ).toBeTruthy();
      expect(await store.listSnapshots("session")).toHaveLength(1);
      expect(updateAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session",
          turnId: "turn",
          narrativeText: value.narrativeOutput,
        }),
      );
      expect(events).toContain("turn.resumed");
      expect(events).not.toContain("turn.completed");
    },
  );
});
