import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/plugin-loader";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createApplicationWork } from "../../src/application-work.js";

describe("resume commit composition", () => {
  it.each([
    { owned: true, shutdown: "none" },
    { owned: false, shutdown: "none" },
    { owned: true, shutdown: "handler" },
    { owned: true, shutdown: "commit" },
  ])(
    "enforces ownership and shutdown across resume (owned=$owned, shutdown=$shutdown)",
    async ({ owned, shutdown }) => {
      const applicationWork = createApplicationWork();
      let closing: Promise<void> | undefined;
      const store = createMemoryStore();
      const now = new Date().toISOString();
      await store.createSession({
        id: "session",
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
        manifests: [
          {
            runtime: { type: manifest.runtimeType ?? ("agent" as const) },
            manifest,
            promptTemplate: "",
            rawFrontmatter: {},
          },
        ],
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
        handler: (async () => {
          if (shutdown === "handler") closing = applicationWork.close();
          return { outcome: "success", value };
        }) satisfies FunctionHandler,
      }));
      const isReferencedBy = vi.fn(async () => {
        if (shutdown === "commit") closing = applicationWork.close();
        return owned;
      });
      const events: string[] = [];
      const eventBus = createEventBus();
      eventBus.onEmit((event) => events.push(event.type));
      const app = new Hono();
      app.use("*", applicationWork.middleware);
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
          ...createMemoryMediaStore(),
          lookup: async () => ({
            id: "asset",
            mime: "image/png",
            size: 42,
            ownerSessionId: "session",
            ownerPluginId: null,
          }),
          isReferencedBy,
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
      await (closing ?? applicationWork.close());
      if (shutdown !== "none") {
        expect(response.status, await response.text()).toBe(500);
        expect(
          (await store.getSuspension("suspension"))?.resolvedAt,
        ).toBeUndefined();
        expect(await store.listRuntimeExports("session")).toEqual([]);
        expect(await store.listTurnMessages("session")).toEqual([]);
        expect(await store.listSnapshots("session")).toEqual([]);
        expect(events).not.toContain("turn.resumed");
        return;
      }
      expect(response.status, await response.text()).toBe(200);
      const exports = await store.listRuntimeExports("session");
      expect(exports).toHaveLength(owned ? 1 : 0);
      if (owned)
        expect(exports[0]!.value).toEqual({
          ...value,
          portrait: { id: assetId, mime: "image/png", size: 42 },
        });
      expect(isReferencedBy).toHaveBeenCalledWith(assetId, "session");
      expect(
        (await store.getSuspension("suspension"))?.resolvedAt,
      ).toBeTruthy();
      expect(await store.listSnapshots("session")).toHaveLength(1);
      expect(events).toContain("turn.resumed");
      expect(events).not.toContain("turn.completed");
    },
  );

  it.each([
    { otherDone: false, phase: "setup" },
    { otherDone: true, phase: "playing" },
  ])(
    "records a resumed setup runtime as done against the session's active setup set (otherDone=$otherDone)",
    async ({ otherDone, phase }) => {
      const applicationWork = createApplicationWork();
      const store = createMemoryStore();
      const now = new Date().toISOString();
      await store.createSession({
        id: "session",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: otherDone
          ? {
              "setup/other": {
                state: "done",
                resolution: "completed",
                pluginVersion: "1.0.0",
                generation: 1,
                attempts: 1,
                completedAt: now,
              },
            }
          : {},
        activePlugins: ["setup"],
        metadata: {
          approvalScopeNonce: "approval-test",
          sessionIncarnationNonce: "session-test",
        },
        locale: "en",
        createdAt: now,
        updatedAt: now,
      });
      const manifests = ["setup/confirm", "setup/other"].map(
        (name) =>
          ({
            name,
            pluginId: "setup",
            pluginType: "plugin",
            version: "1.0.0",
            description: name,
            stage: "setup",
            trigger: { type: "auto" },
            runtimeType: "function",
            outputKind: "plugin",
          }) as RuntimeManifest,
      );
      const pluginRegistry = createPluginRegistry();
      pluginRegistry.register({
        id: "setup",
        source: "builtin",
        status: "registered",
        loadedRuntimes: new Map(),
        summary: {
          id: "setup",
          name: "Setup",
          description: "",
          pluginType: "plugin",
          runtimeCount: manifests.length,
        },
        manifests: manifests.map((manifest) => ({
          runtime: { type: "function" as const },
          manifest,
          promptTemplate: "",
          rawFrontmatter: {},
        })),
      });
      await store.saveSuspension({
        id: "suspension",
        sessionId: "session",
        turnId: "turn",
        runtimeId: "setup/confirm",
        pluginId: "setup",
        reason: "input",
        resumeSchema: {},
        createdAt: now,
        pendingContinuation: {
          executionContext: {
            executionId: "original-run",
            origin: "player",
            countPolicy: "none",
          },
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
        },
      });
      const app = new Hono();
      app.use("*", applicationWork.middleware);
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", pluginRegistry);
        c.set("sessionLock", createInProcessSessionLock());
        c.set("eventBus", createEventBus());
        c.set("loadRuntimeFn", async (manifest: RuntimeManifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => ({
            outcome: "success",
            value: { content: "Confirmed." },
            completion: "done",
          }),
        }));
        c.set("getPluginSource", () => "builtin");
        c.set("llmAdapter", {
          generate: async () => {
            throw new Error("function must not use LLM");
          },
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
      await applicationWork.close();
      expect(response.status, await response.text()).toBe(200);
      const session = await store.getSession("session");
      expect(session?.setupRuntimes["setup/confirm"]).toMatchObject({
        state: "done",
        resolution: "completed",
        attempts: 1,
      });
      expect(session?.phase).toBe(phase);
    },
  );
});
