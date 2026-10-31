import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createHookPipeline, PluginServiceRegistry } from "@covel/runtime";
import { z } from "zod";
import type { Proposal, RuntimeManifest, RuntimeResult } from "@covel/shared";
import { sessionTurnRoutes } from "../../src/routes/api/session-turns.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

describe("action read-baseline corrections and projections", () => {
  it.each([false, true])(
    "keeps story and private read evidence out of transport and traces (stale=%s)",
    async (stale) => {
      const store = createMemoryStore();
      const sessionId = "read-baseline-action";
      const pluginId = "writer";
      const secret = "hidden-read-value-sentinel";
      const now = "2026-10-31T00:00:00.000Z";
      const set = (namespace: string, key: string, value: unknown) =>
        store.setPluginData({
          id: `${namespace}:${key}`,
          sessionId,
          pluginId,
          namespace,
          key,
          value,
          createdAt: now,
          updatedAt: now,
        });
      await store.createSession({
        id: sessionId,
        locale: "en",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: [pluginId, "bank"],
        completedPlayerTurns: 0,
        metadata: {
          approvalScopeNonce: crypto.randomUUID(),
          sessionIncarnationNonce: crypto.randomUUID(),
        },
        createdAt: now,
        updatedAt: now,
      });
      await set("_hidden.baseline-private", "private-key", secret);
      await set("notes", "score", { score: 10 });
      const providerRow = {
        id: "bank-row",
        sessionId,
        pluginId: "bank",
        namespace: "wallet",
        key: "score",
        value: { score: 10 },
        createdAt: now,
        updatedAt: now,
      };
      await store.setPluginData(providerRow);
      const services = new PluginServiceRegistry({
        list: async () => [pluginId, "bank"],
        ensure: async () => {},
      });
      services.register("bank", {
        name: "derive",
        contract: "bank.derive@1",
        access: "write",
        input: z.object({ secret: z.string() }),
        output: z.unknown(),
        handler: async ({ secret }, ctx) => {
          const value = (await ctx.pluginData.get("wallet", "score")) as {
            score: number;
          };
          await ctx.pluginData.update("wallet", "score", [
            { op: "inc", path: "/score", by: 1 },
            { op: "merge", value: { bar: value.score + 101 } },
          ]);
          return { privateResult: secret };
        },
      });
      const story = {
        name: "writer/story",
        pluginId,
        description: "story",
        runtimeType: "function",
        stage: "narrative",
        outputKind: "story",
        trigger: { type: "auto" },
      } as RuntimeManifest;
      const writer = {
        ...story,
        name: "writer/derive",
        stage: "post-turn",
        outputKind: "system",
        concealed: true,
      } as RuntimeManifest;
      const loaded = new Map<string, LoadedRuntime>([
        [
          story.name,
          {
            manifest: story,
            promptTemplate: "",
            handler: async () => ({
              outcome: "success",
              value: { narrativeOutput: "The story continues." },
            }),
          },
        ],
        [
          writer.name,
          {
            manifest: writer,
            promptTemplate: "",
            handler: async (ctx) => {
              const hidden = await ctx.pluginData!.get(
                "_hidden.baseline-private",
                "private-key",
              );
              const value = (await ctx.pluginData!.get("notes", "score")) as {
                score: number;
              };
              await ctx.pluginData!.set(
                "_hidden.baseline-private",
                "private-key",
                "updated",
              );
              await ctx.pluginData!.update("notes", "score", [
                { op: "inc", path: "/score", by: 5 },
                { op: "merge", value: { bar: value.score + 105 } },
              ]);
              await ctx.services!.call({
                pluginId: "bank",
                name: "derive",
                contract: "bank.derive@1",
                input: { secret: String(hidden) },
              });
              return { outcome: "success", value: {} };
            },
          },
        ],
      ]);
      const hookPipeline = createHookPipeline();
      hookPipeline.register<{ proposal: Proposal }>({
        id: "intervening-write",
        pluginId,
        event: "PreStateCommit",
        handler: async (_ctx, { proposal }) => {
          expect(proposal).not.toHaveProperty("preconditions");
          if (
            stale &&
            proposal.source.pluginId === "bank" &&
            proposal.type === "plugin.data.update"
          )
            await store.setPluginData({ ...providerRow, value: { score: 20 } });
          return { action: "continue" };
        },
      });
      const pluginRegistry = createPluginRegistry();
      pluginRegistry.register({
        id: pluginId,
        summary: {
          id: pluginId,
          name: pluginId,
          description: "",
          kind: "plugin",
          runtimeCount: 2,
        },
        manifests: [story, writer].map((manifest) => ({
          runtime: { function: {} },
          manifest,
          promptTemplate: "",
          rawFrontmatter: {},
        })),
        loadedRuntimes: loaded,
        status: "registered",
        source: "builtin",
      } as PluginRegistryEntry);
      pluginRegistry.register({
        id: "bank",
        summary: {
          id: "bank",
          name: "bank",
          description: "",
          kind: "plugin",
          runtimeCount: 0,
        },
        manifests: [],
        loadedRuntimes: new Map(),
        status: "registered",
        source: "builtin",
      } as PluginRegistryEntry);
      const eventBus = createEventBus(store);
      const sessionLock = createInProcessSessionLock();
      const llm = {
        generate: async () => {
          throw new Error("Unexpected model call");
        },
      };
      const loadRuntimeFn = async (manifest: RuntimeManifest) =>
        loaded.get(manifest.name);
      const worker = createTestRuntimeJobWorker({
        store,
        eventBus,
        sessionLock,
        pluginRegistry,
        deps: {
          llm,
          loadRuntime: loadRuntimeFn,
          resolveModel: () => undefined,
        },
      });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", pluginRegistry);
        c.set("eventBus", eventBus);
        c.set("sessionLock", sessionLock);
        c.set("runtimeJobWorker", worker);
        c.set("llmAdapter", llm);
        c.set("loadRuntimeFn", loadRuntimeFn);
        c.set("resolveModel", () => undefined);
        c.set("hookPipeline", hookPipeline);
        c.set("pluginServices", services);
        await next();
      });
      app.route("/api/actions", actionRoutes);
      app.route("/api/sessions", sessionTurnRoutes);
      const response = await app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "read-baseline-request",
          type: "submit_actions",
          sessionId,
          payload: { actions: [{ kind: "say", text: "go" }] },
        }),
      });
      const wire = await response.text();
      expect(wire).toContain('"committed":true');
      const results = (await store.listTurnResults(sessionId)).flatMap(
        (row) => row.runtimeResults as RuntimeResult[],
      );
      expect(
        results.find((result) => result.runtimeId === story.name)?.status,
      ).toBe("success");
      expect(
        results.find((result) => result.runtimeId === writer.name)?.status,
      ).toBe(stale ? "failed" : "success");
      if (stale) expect(wire).toContain('"runtime.failed"');
      const traces = await store.queryTraceEvents(sessionId, {});
      const publicTurns = await app.request(`/api/sessions/${sessionId}/turns`);
      expect(publicTurns.status).toBe(200);
      expect(
        wire + JSON.stringify(traces) + (await publicTurns.text()),
      ).not.toMatch(
        /hidden-read-value-sentinel|baseline-private|private-key|preconditions|fingerprint|readScopes/,
      );
      expect(
        (await store.getPluginData(sessionId, pluginId, "notes", "score"))
          ?.value,
      ).toEqual(stale ? { score: 10 } : { score: 15, bar: 115 });
      expect(JSON.stringify(results)).not.toMatch(
        /preconditions|fingerprint|readScopes/,
      );
      await store.close();
    },
  );
});
