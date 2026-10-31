import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
  provideHostModules,
} from "@covel/plugin-loader";
import type { PluginAPI } from "@covel/plugin-handlers-utils";
import { characterActorOutputJsonSchema } from "@covel/shared";
import type { LLMAdapter, StorySegment } from "@covel/shared";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import { delegateTool } from "@covel/tools";
import { loadRuntimeBundle } from "../../test-runtime/src/runtime-loading.js";
import {
  PluginServiceRegistry,
  enforcePluginRegistrationContract,
  executeTurn,
  commitExecution,
  createToolExecutor,
  createTurnEmitter,
} from "../src/index.js";
import { prose, toolCall } from "./_helpers/agent-loop-fixture.js";

const root = path.resolve(import.meta.dirname, "../../../plugins");
describe("bundled orchestration", () => {
  it.each([
    "success",
    "concealed-actor",
    "director",
    "one-fails",
    "all-fail",
    "missing-actor",
    "ambiguous-actor",
    "missing-policy",
    "stale-policy",
    "planner-failure",
    "invalid-selection",
    "zero-caps",
  ])(
    "commits the real dialogue pipeline with isolated contributions: %s",
    async (mode) => {
      const store = createMemoryStore();
      const active = [
        "chat-mode-narrator",
        ...(mode === "missing-actor" ? [] : ["character-agent"]),
        ...(mode === "missing-policy" ? [] : ["turn-policy"]),
      ];
      const now = "2026-10-31T00:00:00.000Z";
      await store.createSession({
        id: "scene",
        locale: "en-US",
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        seats: [
          { id: "host", controller: "human", role: "host", characters: [] },
        ],
        activePlugins: active,
        metadata: {
          orchestration:
            mode === "zero-caps"
              ? { maxActors: 0 }
              : mode === "stale-policy"
                ? {
                    turnPolicy: {
                      pluginId: "unavailable-provider",
                      name: "old-service",
                    },
                  }
                : {},
        },
        createdAt: now,
        updatedAt: now,
      });
      for (const [id, name, secret] of [
        ["private-a", "Mara", "MARA-WITNESS"],
        ["private-b", "Ivo", "IVO-WITNESS"],
        ["private-c", "Sable", "SABLE-WITNESS"],
      ]) {
        await store.upsertCharacter({
          id: id!,
          name: name!,
          sessionId: "scene",
          type: "npc",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        await store.addMessage({
          id: `history-${id}`,
          sessionId: "scene",
          role: "assistant",
          content: secret!,
          metadata: {
            kind: "story",
            presentCharacterIds: [id],
            segments: [{ kind: "narration", text: secret }],
          },
          createdAt: now,
        });
        await store.appendTurnMessage({
          id: `parent-history-${id}`,
          sessionId: "scene",
          turnId: `earlier-${id}`,
          sourceType: "runtime",
          sourcePluginId: "chat-mode-narrator",
          sourceRuntimeId: "chat-mode-narrator/narrate",
          role: "assistant",
          content: secret!,
          order: 500,
          createdAt: now,
        });
      }
      const bundle = await loadRuntimeBundle({
        pluginsDir: root,
        pluginId: "chat-mode-narrator",
        runtimeId: "chat-mode-narrator/narrate",
        locale: "en-US",
        withPlugins: active.filter((id) => id !== "chat-mode-narrator"),
        store,
      });
      const actorRequests: string[] = [];
      const parentRequests: string[] = [];
      const directorRequests: string[] = [];
      const gateway: PluginRuntimeGateway = {
        resolveSlot: () => ({
          presetId: "plugin",
          provider: "synthetic",
          protocol: "openai-chat-v1",
          model: "test",
          tag: "text",
          metadata: {},
        }),
        generateText: async () => {
          throw new Error("Unexpected text generation");
        },
        generateObject: async <T>(
          request: Parameters<PluginRuntimeGateway["generateObject"]>[0],
        ) => {
          expect(request.signal).toBeDefined();
          directorRequests.push(request.prompt ?? "");
          return {
            object: {
              actors: [{ character: "Mara" }, { character: "Ivo" }],
              order: "sequential",
              narrator: "after",
              yieldHint: "user",
            } as T,
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const manifests = [...bundle.manifests];
      if (mode === "concealed-actor") {
        const index = manifests.findIndex(
          (manifest) => manifest.outputContract === "character-actor@1",
        );
        manifests[index] = { ...manifests[index]!, concealed: true };
      }
      if (mode === "ambiguous-actor") {
        const actor = manifests.find(
          (manifest) => manifest.outputContract === "character-actor@1",
        )!;
        manifests.push({
          ...actor,
          name: "alternate-actor",
          pluginId: "alternate-actor",
        });
        active.push("alternate-actor");
        await store.updateSession("scene", {
          activePlugins: active,
          updatedAt: now,
        });
      }
      const delegates: string[] = [];
      const llm: LLMAdapter = {
        generate: async (request) => {
          const text = JSON.stringify(request.messages);
          if (text.includes("Play only the character assigned")) {
            actorRequests.push(text);
            const name =
              text.includes('"name":"Mara"') ||
              text.includes('\\"name\\":\\"Mara\\"')
                ? "Mara"
                : "Ivo";
            expect(text).not.toContain("PARENT-PRIVATE-DIRECTION");
            expect(text).not.toContain("SABLE-WITNESS");
            expect(text).not.toContain(
              name === "Mara" ? "IVO-WITNESS" : "MARA-WITNESS",
            );
            expect(text).toContain(
              name === "Mara" ? "MARA-WITNESS" : "IVO-WITNESS",
            );
            if (mode === "all-fail" || (mode === "one-fails" && name === "Ivo"))
              throw new Error("Actor model unavailable");
            return prose(
              JSON.stringify({
                segments: [{ kind: "dialogue", text: `${name} answers.` }],
                intent: `PRIVATE-INTENT-${name}`,
              }),
            );
          }
          parentRequests.push(text);
          const block = request.messages
            .map((message) =>
              typeof message.content === "string" ? message.content : "",
            )
            .join("\n")
            .match(/<runtime-inputs>\n([\s\S]*?)\n<\/runtime-inputs>/);
          const parsed = block?.[1]
            ? (JSON.parse(
                block[1]
                  .replaceAll("&lt;", "<")
                  .replaceAll("&gt;", ">")
                  .replaceAll("&amp;", "&"),
              ) as {
                plan?: {
                  value?: {
                    actors: { character: string }[];
                    cast: string[];
                    status?: string;
                    yieldHint?: "user" | "continue";
                  };
                };
              })
            : undefined;
          const plan = parsed?.plan?.value;
          const delegateIds = new Set(
            request.messages
              .flatMap((message) => message.toolCalls ?? [])
              .filter((call) => call.name === "delegate")
              .map((call) => call.id),
          );
          const receipts = request.messages.filter(
            (message) =>
              message.role === "tool" &&
              message.toolCallId !== undefined &&
              delegateIds.has(message.toolCallId),
          );
          const next = plan?.actors[receipts.length];
          if (next) {
            delegates.push(next.character);
            return toolCall(
              "delegate",
              {
                target: { contract: "character-actor@1" },
                character: next.character,
                brief: "The bell rings. Respond briefly.",
              },
              `actor-${next.character}`,
            );
          }
          const segments: StorySegment[] = receipts.flatMap(
            (message, index) => {
              const result = JSON.parse(String(message.content)) as {
                data?: {
                  segments?: { kind: "dialogue" | "action"; text: string }[];
                };
              };
              return (result.data?.segments ?? []).map((segment) => ({
                ...segment,
                speaker: plan!.actors[index]!.character,
              }));
            },
          );
          return prose(
            JSON.stringify({
              segments: [
                ...segments,
                {
                  kind: "narration",
                  text:
                    plan?.status === "invalid-selection"
                      ? "The bell falls silent. Correct the actor names."
                      : "The bell falls silent.",
                },
              ],
              cues: { present: plan?.cast ?? [] },
              yield: segments.length ? (plan?.yieldHint ?? "user") : "user",
            }),
          );
        },
      };
      try {
        const execution = await executeTurn(
          {
            sessionId: "scene",
            turnId: "beat",
            locale: "en-US",
            origin: "player",
            playerMessage: "Mara and Ivo. PARENT-PRIVATE-DIRECTION",
            actions:
              mode === "invalid-selection"
                ? [
                    {
                      kind: "turn-policy/choose-actors",
                      source: "player",
                      seatId: "host",
                      fields: { actors: "Mara\nUnknown" },
                    },
                  ]
                : [
                    {
                      kind: "direct",
                      source: "player",
                      seatId: "host",
                      text: "Mara and Ivo. PARENT-PRIVATE-DIRECTION",
                    },
                  ],
          },
          manifests,
          {
            store,
            llm,
            gateway: mode === "director" ? gateway : undefined,
            services: bundle.services,
            hookPipeline: bundle.hookPipeline,
            extensions: bundle.extensions,
            hookScope: {
              activePluginIds: new Set(active),
              settings: {
                "turn-policy": {
                  strategy:
                    mode === "invalid-selection"
                      ? "manual"
                      : mode === "director"
                        ? "director"
                        : "list",
                },
                "chat-mode-narrator": { perspective: "dm" },
              },
              locale: "en-US",
            },
            emitter: createTurnEmitter({
              store,
              sessionId: "scene",
              turnId: "beat",
            }),
            toolExecutor: createToolExecutor({
              store,
              findTool: (name) =>
                name === "delegate" ? delegateTool : undefined,
            }),
            loadRuntime: async (manifest) => {
              const loaded = bundle.loadedCache.get(manifest.name);
              return mode === "planner-failure" &&
                manifest.name === "chat-mode-narrator/plan" &&
                loaded
                ? {
                    ...loaded,
                    handler: async () => {
                      throw new Error("Planner unavailable");
                    },
                  }
                : loaded;
            },
          },
        );
        expect(
          execution.result.runtimeResults.find(
            (result) => result.runtimeId === bundle.target.name,
          )?.status,
        ).toBe("success");
        expect(
          (
            await commitExecution({
              store,
              execution,
              completion: { kind: "turn", turnId: "beat", durationMs: 0 },
            })
          ).status,
        ).toBe("committed");
        const stories = (await store.listMessages("scene")).filter(
          (row) => !row.id.startsWith("history-"),
        );
        expect(stories).toHaveLength(1);
        const content = JSON.stringify(stories);
        expect(content).toContain("The bell falls silent.");
        expect(content).not.toContain("PRIVATE-INTENT");
        if (mode === "invalid-selection") {
          expect(
            execution.result.runtimeResults.find(
              (result) => result.runtimeId === "chat-mode-narrator/plan",
            )?.output,
          ).toMatchObject({ status: "invalid-selection", actors: [] });
          expect(content).toContain("Correct the actor names.");
        }
        if (
          ["success", "concealed-actor", "director", "one-fails"].includes(mode)
        )
          expect(content).toContain("Mara answers.");
        if (["success", "concealed-actor", "director"].includes(mode))
          expect(content).toContain("Ivo answers.");
        else expect(content).not.toContain("Ivo answers.");
        if (
          mode === "all-fail" ||
          mode === "missing-actor" ||
          mode === "ambiguous-actor" ||
          mode === "missing-policy" ||
          mode === "stale-policy" ||
          mode === "planner-failure" ||
          mode === "invalid-selection" ||
          mode === "zero-caps"
        )
          expect(content).toContain('"yield":"user"');
        expect(delegates).toEqual(
          [
            "missing-policy",
            "stale-policy",
            "planner-failure",
            "invalid-selection",
            "zero-caps",
          ].includes(mode)
            ? []
            : ["Mara", "Ivo"],
        );
        expect(actorRequests).toHaveLength(
          [
            "missing-actor",
            "ambiguous-actor",
            "missing-policy",
            "stale-policy",
            "planner-failure",
            "invalid-selection",
            "zero-caps",
          ].includes(mode)
            ? 0
            : 2,
        );
        const trace = await store.queryTraceEvents("scene", {
          turnId: "beat",
          limit: 1000,
        });
        expect(JSON.stringify(trace)).not.toContain("PRIVATE-INTENT");
        if (
          ["success", "concealed-actor", "director", "one-fails"].includes(mode)
        )
          expect(
            parentRequests.some((request) =>
              request.includes("PRIVATE-INTENT-Mara"),
            ),
          ).toBe(true);
        expect(
          parentRequests.some((request) => request.includes("SABLE-WITNESS")),
        ).toBe(true);
        if (mode === "director") {
          expect(directorRequests).toHaveLength(1);
          expect(directorRequests[0]).toContain("Mara");
          expect(directorRequests[0]).not.toMatch(
            /private-a|private-b|characterId|seatId|actorId/,
          );
        } else expect(directorRequests).toHaveLength(0);
        if (mode === "one-fails")
          expect(trace.some((event) => event.type === "subagent.failed")).toBe(
            true,
          );
      } finally {
        await bundle.close();
        await store.close();
      }
    },
  );
  it("loads the public actor schema and registers the policy entry against its declaration", async () => {
    const discoveries = await discoverPlugins(root);
    const actor = discoveries.find(({ id }) => id === "character-agent")!;
    const actorDefinition = await loadPluginDefinition(actor);
    expect(actorDefinition.manifests).toHaveLength(1);
    const loaded = await loadRuntime(
      actor,
      actorDefinition.manifests[0]!.manifest.name,
    );
    expect(loaded.outputContractSchema).toEqual(
      characterActorOutputJsonSchema(),
    );
    const discovery = discoveries.find(({ id }) => id === "turn-policy")!;
    const definition = await loadPluginDefinition(discovery);
    provideHostModules(discovery.rootPath);
    const entry = (await import(
      pathToFileURL(path.join(discovery.rootPath, "server/index.js")).href
    )) as { default(api: PluginAPI): void };
    const registry = new PluginServiceRegistry({
      list: async () => ["turn-policy"],
      ensure: async () => {},
    });
    const checked = enforcePluginRegistrationContract(
      {
        pluginId: "turn-policy",
        registerService: (
          service: Parameters<PluginAPI["registerService"]>[0],
        ) => registry.register("turn-policy", service),
      } as unknown as PluginAPI,
      definition.packageManifest.plugin.contributes ?? {},
    );
    entry.default(checked.api);
    checked.validate();
    expect(
      registry.list().map(({ name, contract }) => ({ name, contract })),
    ).toEqual([{ name: "turn-policy", contract: "turn-policy@1" }]);
  });
});
