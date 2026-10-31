import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { LLMAdapter, RuntimeManifest, RuntimeResult } from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { sessionTurnRoutes } from "../../src/routes/api/session-turns.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";

const SESSION = "world-read-stream";
const PLUGIN = "world-probe";
const SECRET = "concealed-world-sentinel";
const manifest = (
  id: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest => ({
  name: `${PLUGIN}/${id}`,
  pluginId: PLUGIN,
  description: id,
  runtimeType: "function",
  handler: "handler.js",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  ...extra,
});

describe("action streams for rejected world producers", () => {
  it.each([false, true])(
    "corrects readers by run, keeps the story and conceals private content: %s",
    async (concealed) => {
      const store = createMemoryStore();
      const eventBus = createEventBus(store);
      const sessionLock = createInProcessSessionLock();
      const pluginRegistry = createPluginRegistry();
      const producer = manifest("producer", { stage: "pre-turn", concealed });
      const reader = manifest("reader", { concealed });
      const story = manifest("story", {
        stage: "narrative",
        outputKind: "story",
      });
      const loaded = new Map<string, LoadedRuntime>([
        [
          producer.name,
          {
            manifest: producer,
            promptTemplate: concealed ? SECRET : "",
            handler: async (ctx) =>
              withPendingProposals(
                {
                  outcome: "success",
                  value: { private: SECRET },
                  effects: {
                    pluginData: [
                      { namespace: "_jobs", key: "reject", value: SECRET },
                    ],
                  },
                },
                [
                  {
                    id: crypto.randomUUID(),
                    type: "character.upsert",
                    sessionId: SESSION,
                    turnId: ctx.turnId,
                    source: { pluginId: PLUGIN, runtimeId: producer.name },
                    timestamp: new Date().toISOString(),
                    payload: {
                      id: "visitor",
                      name: "Visitor",
                      type: "npc",
                      description: SECRET,
                    },
                  },
                ],
              ),
          },
        ],
        [
          reader.name,
          {
            manifest: reader,
            promptTemplate: concealed ? SECRET : "",
            handler: async (ctx) => {
              const description = ctx.world!.characters.find(
                (c) => c.id === "visitor",
              )?.description;
              expect(description).toBe(SECRET);
              await ctx.pluginData!.set("notes", "derived", description!);
              return { outcome: "success", value: { private: SECRET } };
            },
          },
        ],
        [
          story.name,
          {
            manifest: story,
            promptTemplate: "",
            handler: async (ctx) => {
              void ctx.world!.characters;
              void ctx.world!.characters;
              return {
                outcome: "success",
                value: { narrativeOutput: "The story continues." },
              };
            },
          },
        ],
      ]);
      pluginRegistry.register({
        id: PLUGIN,
        summary: {
          id: PLUGIN,
          name: PLUGIN,
          description: "",
          kind: "plugin",
          runtimeCount: 3,
        },
        manifests: [producer, story, reader].map((m) => ({
          runtime: { function: {} },
          manifest: m,
          promptTemplate: "",
          rawFrontmatter: {},
        })),
        loadedRuntimes: loaded,
        status: "registered",
        source: "builtin",
      } as PluginRegistryEntry);
      const loadRuntimeFn = async (m: RuntimeManifest) => loaded.get(m.name);
      const llm: LLMAdapter = {
        generate: async () => {
          throw new Error("Functions do not use a model");
        },
      };
      const runtimeJobWorker = createTestRuntimeJobWorker({
        store,
        eventBus,
        sessionLock,
        pluginRegistry,
        deps: {
          loadRuntime: loadRuntimeFn,
          llm,
          resolveModel: () => undefined,
        },
      });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("runtimeJobWorker", runtimeJobWorker);
        c.set("store", store);
        c.set("pluginRegistry", pluginRegistry);
        c.set("llmAdapter", llm);
        c.set("loadRuntimeFn", loadRuntimeFn);
        c.set("resolveModel", () => undefined);
        c.set("eventBus", eventBus);
        c.set("sessionLock", sessionLock);
        await next();
      });
      app.route("/api/actions", actionRoutes);
      app.route("/api/sessions", sessionTurnRoutes);
      const now = new Date().toISOString();
      await store.createSession({
        id: SESSION,
        locale: "en-US",
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
        activePlugins: [PLUGIN],
        completedPlayerTurns: 0,
        metadata: {
          approvalScopeNonce: crypto.randomUUID(),
          sessionIncarnationNonce: crypto.randomUUID(),
        },
        createdAt: now,
        updatedAt: now,
      });
      try {
        const response = await app.request("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            type: "submit_actions",
            sessionId: SESSION,
            payload: { actions: [{ kind: "say", text: "Continue" }] },
          }),
        });
        const body = await response.text();
        expect(response.status, body).toBe(200);
        const events = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map(
            (line) =>
              JSON.parse(line.slice(6)) as {
                type: string;
                payload: Record<string, unknown>;
              },
          );
        const turns = await store.listTurnResults(SESSION);
        expect(turns.every((turn) => turn.commitStatus === "committed")).toBe(
          true,
        );
        const persisted = turns.flatMap(
          (turn) => turn.runtimeResults as RuntimeResult[],
        );
        const readerResult = persisted.find(
          (r) => r.runtimeId === reader.name,
        )!;
        expect(readerResult.status).toBe("failed");
        const correction = events.findIndex(
          (e) =>
            e.type === "runtime.failed" &&
            e.payload.runId === readerResult.runId,
        );
        expect(correction).toBeGreaterThanOrEqual(0);
        const completed = events.findIndex(
          (e) => e.type === "execution.completed",
        );
        expect(completed).toBeGreaterThan(correction);
        expect(events[completed]?.payload).toMatchObject({ committed: true });
        expect(
          events.filter(
            (e) =>
              e.type === "runtime.failed" && e.payload.runtimeId === story.name,
          ),
        ).toEqual([]);
        expect(events.filter((e) => e.type === "operation.failed")).toEqual([]);
        const rejections = events.filter((e) => e.type === "proposal.failed");
        expect(rejections.length).toBeGreaterThan(0);
        expect(
          rejections.every((e) => e.payload.runtimeId === producer.name),
        ).toBe(true);
        const kept = await store.queryTraceEvents(SESSION, {
          types: ["read-dependency.kept"],
        });
        expect(kept).toHaveLength(1);
        expect(kept[0]?.payload).toMatchObject({
          runtimeId: story.name,
          producerRunId: persisted.find((r) => r.runtimeId === producer.name)
            ?.runId,
        });
        expect(JSON.stringify(kept)).not.toContain(SECRET);
        expect(JSON.stringify(events[correction])).not.toContain(SECRET);
        expect(JSON.stringify(events[correction])).not.toContain("_jobs");
        expect(await store.listCharacters(SESSION)).toEqual([]);
        expect(await store.listPluginData(SESSION, PLUGIN, "notes")).toEqual(
          [],
        );
        expect(
          (await store.listMessages(SESSION)).map((m) => m.content),
        ).toContain("The story continues.");
        const route = await app.request(`/api/sessions/${SESSION}/turns`);
        expect(route.status).toBe(200);
        const rendered = await route.text();
        if (concealed) {
          expect(body).not.toContain(SECRET);
          expect(rendered).not.toContain(SECRET);
        }
        expect(rendered).not.toContain("readDependencies");
      } finally {
        await store.close();
      }
    },
  );
});
