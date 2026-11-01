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
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import { characterActorOutputJsonSchema } from "@covel/shared";
import type { LLMAdapter, StorySegment, RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  createDefaultToolRegistry,
  tool,
  z,
  withPendingProposals,
} from "@covel/tools";
import { loadRuntimeBundle } from "../../test-runtime/src/runtime-loading.js";
import {
  PluginServiceRegistry,
  enforcePluginRegistrationContract,
  executeTurn,
  commitExecution,
  createToolExecutor,
  createTurnEmitter,
} from "../src/index.js";
import { prose, toolCall, latch } from "./_helpers/agent-loop-fixture.js";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";

const root = path.resolve(import.meta.dirname, "../../../plugins");
describe("bundled orchestration", () => {
  it.each([
    "success",
    "inherited-world",
    "inherited-world-failure",
    "concealed-actor",
    "director",
    "director-parallel",
    "director-parallel-one-fails",
    "director-parallel-all-fail",
    "director-no-slot",
    "director-no-gateway",
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
      const directorMode = mode.startsWith("director");
      const parallel = mode.startsWith("director-parallel");
      const rendezvous = latch(2);
      const inherited = mode.startsWith("inherited-world");
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
      const parentToolNames: string[][] = [];
      const directorRequests: string[] = [];
      const adapter: ModelProviderAdapter = {
        generateText: async () => {
          throw new Error("Unexpected text generation");
        },
        generateObject: async (config, request) => {
          expect(config.signal).toBeDefined();
          expect(config.apiKey).toBe("browser-key");
          expect(request.model).toBe("browser-director");
          directorRequests.push(JSON.stringify(request.messages));
          return {
            object: request.schema.parse({
              actors: [{ character: "Mara" }, { character: "Ivo" }],
              order: parallel ? "parallel" : "sequential",
              narrator: "after",
              yieldHint: "user",
            }),
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        async *streamText() {
          throw new Error("Unexpected streaming generation");
        },
        embed: async () => {
          throw new Error("Unexpected embedding");
        },
      };
      const presets = createPresetRegistry({ profiles: [], presets: [] });
      const fullGateway = createGateway({
        presetRegistry: presets,
        providerRegistry: createProviderRegistry({
          providers: { synthetic: { adapter } },
        }),
      });
      const gateway = createPluginRuntimeGateway(fullGateway, {
        apiKeys: { synthetic: "browser-key" },
        slotOverrides: {
          slotBindings: {
            story: { modelRef: "browser-story" },
            plugin: { modelRef: "browser-plugin" },
          },
          customPresets: [
            {
              id: "browser-story",
              name: "Story",
              provider: "synthetic",
              model: "browser-narrator",
              baseUrl: "https://model.example",
              protocol: "openai-chat-v1",
            },
            {
              id: "browser-plugin",
              name: "Director",
              provider: "synthetic",
              model: "browser-director",
              baseUrl: "https://model.example",
              protocol: "openai-chat-v1",
            },
          ],
        },
      });
      expect(gateway.resolveSlot({})).toBeNull();
      expect(gateway.resolveSlot({ presetId: "plugin" })?.model).toBe(
        "browser-director",
      );
      const previous = {
        segments: [
          { kind: "dialogue", speaker: "Mara", text: "MARA-PRIVATE-EXCHANGE" },
          { kind: "narration", text: "OMNISCIENT-SECRET" },
        ],
        cues: { present: ["Mara"] },
      } as const;
      await store.addMessage({
        id: "history-private-exchange",
        sessionId: "scene",
        role: "assistant",
        content: "MARA-PRIVATE-EXCHANGE",
        metadata: {
          kind: "story",
          presentCharacterIds: ["private-a"],
          segments: previous.segments,
        },
        createdAt: now,
      });
      await store.appendRuntimeExport({
        sessionId: "scene",
        producerPluginId: "chat-mode-narrator",
        producerRuntimeId: "chat-mode-narrator/narrate",
        recordAs: "latest-story",
        revision: 1,
        pluginVersion: bundle.target.version ?? "0.0.1",
        schemaDigest: "fixture",
        resultId: "previous-story",
        value: previous,
        committedAt: now,
      });
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
      const worldProducer: RuntimeManifest = {
        pluginId: "world-updater",
        name: "world-updater/stage",
        description: "Stage a character",
        runtimeType: "function",
        stage: "pre-turn",
        outputKind: "system",
        trigger: { type: "auto" },
      };
      let actorWorldReads = 0;
      const actorRead = tool({
        name: "read-actor-world",
        description: "Read a visible character",
        annotations: { readOnly: true },
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          actorWorldReads++;
          const description = ctx.world!.characters.find(
            (c) => c.name === "Mara",
          )?.description;
          expect(description).toBe("staged profile");
          return { description };
        },
      });
      if (inherited) {
        const index = manifests.findIndex(
          (manifest) => manifest.outputContract === "character-actor@1",
        );
        manifests[index] = {
          ...manifests[index]!,
          pluginId: "replacement-actor",
          name: "replacement-actor/play",
          tools: { builtin: [actorRead.name] },
        };
        manifests.push(worldProducer);
        active.push("replacement-actor", worldProducer.pluginId);
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
            if (parallel) await rendezvous();
            if (!inherited || !request.messages.some((m) => m.role === "tool"))
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
            if (name === "Ivo") {
              expect(text).not.toContain("MARA-PRIVATE-EXCHANGE");
              expect(text).not.toContain("OMNISCIENT-SECRET");
            }
            if (inherited && !request.messages.some((m) => m.role === "tool"))
              return toolCall(actorRead.name, {}, `read-${name}`);
            if (inherited) expect(text).toContain("staged profile");
            if (
              mode.endsWith("all-fail") ||
              ((mode.endsWith("one-fails") ||
                mode === "inherited-world-failure") &&
                name === "Ivo")
            )
              throw new Error("Actor model unavailable");
            return prose(
              JSON.stringify({
                segments: [{ kind: "dialogue", text: `${name} answers.` }],
                intent: `PRIVATE-INTENT-${name}`,
              }),
            );
          }
          parentRequests.push(text);
          parentToolNames.push((request.tools ?? []).map((tool) => tool.name));
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
                    order: "parallel" | "sequential";
                    cast: string[];
                    brief: string;
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
              .filter((call) =>
                ["delegate", "delegate-batch"].includes(call.name),
              )
              .map((call) => call.id),
          );
          const receipts = request.messages.filter(
            (message) =>
              message.role === "tool" &&
              message.toolCallId !== undefined &&
              delegateIds.has(message.toolCallId),
          );
          if (parallel && !receipts.length && plan?.actors.length) {
            expect(
              request.tools?.some((t) => t.name === "delegate-batch"),
            ).toBe(true);
            expect(text).toContain("delegate-batch");
            delegates.push(...plan.actors.map((a) => a.character));
            return toolCall(
              "delegate-batch",
              {
                requests: plan.actors.map((a) => ({
                  target: { contract: "character-actor@1" },
                  character: a.character,
                  brief: "Respond to the bell in the room.",
                })),
              },
              "actor-batch",
            );
          }
          const next = parallel ? undefined : plan?.actors[receipts.length];
          if (next) {
            delegates.push(next.character);
            return toolCall(
              "delegate",
              {
                target: { contract: "character-actor@1" },
                character: next.character,
                brief: inherited ? "A constant safe brief" : plan!.brief,
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
              if (parallel) {
                const batch = result.data as {
                  results: {
                    ok: boolean;
                    output?: {
                      segments: { kind: "dialogue" | "action"; text: string }[];
                    };
                  }[];
                };
                return batch.results.flatMap((entry, i) =>
                  (entry.output?.segments ?? []).map((segment) => ({
                    ...segment,
                    speaker: plan!.actors[i]!.character,
                  })),
                );
              }
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
      const builtin = createDefaultToolRegistry({
        store,
        eventDirectory: {
          listTopics: async () => [],
          validate: async () => ({ ok: true }),
        },
      });
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
            gateway:
              mode === "director" || parallel
                ? gateway
                : mode === "director-no-slot"
                  ? createPluginRuntimeGateway(fullGateway)
                  : undefined,
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
                      : directorMode
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
                name === actorRead.name
                  ? actorRead
                  : builtin.find(name, "chat-mode-narrator"),
            }),
            loadRuntime: async (manifest) => {
              if (manifest === worldProducer)
                return {
                  manifest,
                  promptTemplate: "",
                  handler: async () =>
                    withPendingProposals(
                      { outcome: "success" as const, value: {} },
                      [
                        {
                          id: crypto.randomUUID(),
                          type: "character.upsert" as const,
                          sessionId: "scene",
                          turnId: "beat",
                          timestamp: now,
                          source: {
                            pluginId: worldProducer.pluginId,
                            runtimeId: worldProducer.name,
                          },
                          payload: {
                            id: "private-a",
                            name: "Mara",
                            type: "npc",
                            description: "staged profile",
                            expectedVersion: 1,
                          },
                        },
                      ],
                    ),
                };
              if (manifest.pluginId === "replacement-actor")
                return {
                  manifest,
                  promptTemplate: "Play only the character assigned",
                  outputSchema: characterActorOutputJsonSchema(),
                  outputContractSchema: characterActorOutputJsonSchema(),
                };

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
        if (
          parallel &&
          !mode.endsWith("all-fail") &&
          !mode.endsWith("one-fails")
        )
          expect(content.indexOf("Mara answers.")).toBeLessThan(
            content.indexOf("Ivo answers."),
          );
        if (mode === "invalid-selection") {
          expect(
            execution.result.runtimeResults.find(
              (result) => result.runtimeId === "chat-mode-narrator/plan",
            )?.output,
          ).toMatchObject({ status: "invalid-selection", actors: [] });
          expect(content).toContain("Correct the actor names.");
        }
        if (
          (directorMode && !mode.endsWith("all-fail")) ||
          [
            "success",
            "concealed-actor",
            "one-fails",
            "inherited-world",
            "inherited-world-failure",
          ].includes(mode)
        )
          expect(content).toContain("Mara answers.");
        if (
          (directorMode &&
            !mode.endsWith("all-fail") &&
            !mode.endsWith("one-fails")) ||
          ["success", "concealed-actor", "inherited-world"].includes(mode)
        )
          expect(content).toContain("Ivo answers.");
        else expect(content).not.toContain("Ivo answers.");
        if (
          mode.endsWith("all-fail") ||
          mode === "missing-actor" ||
          mode === "ambiguous-actor" ||
          mode === "missing-policy" ||
          mode === "stale-policy" ||
          mode === "planner-failure" ||
          mode === "invalid-selection" ||
          mode === "zero-caps"
        )
          expect(content).toContain('"yield":"user"');
        if (mode === "missing-actor") {
          expect(parentToolNames.length).toBeGreaterThan(0);
          for (const offered of parentToolNames) {
            expect(offered).not.toContain("delegate");
            expect(offered).not.toContain("delegate-batch");
          }
        }
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
          (directorMode && !mode.endsWith("all-fail")) ||
          [
            "success",
            "concealed-actor",
            "one-fails",
            "inherited-world",
            "inherited-world-failure",
          ].includes(mode)
        )
          expect(
            parentRequests.some((request) =>
              request.includes("PRIVATE-INTENT-Mara"),
            ),
          ).toBe(true);
        expect(
          parentRequests.some((request) => request.includes("SABLE-WITNESS")),
        ).toBe(true);
        if (mode === "director" || parallel) {
          expect(directorRequests).toHaveLength(1);
          expect(directorRequests[0]).toContain("Mara");
          expect(directorRequests[0]).toContain("MARA-PRIVATE-EXCHANGE");
          expect(directorRequests[0]).toContain("OMNISCIENT-SECRET");
          expect(presets.hasPreset("browser-plugin")).toBe(false);
          expect(directorRequests[0]).not.toMatch(
            /private-a|private-b|characterId|seatId|actorId/,
          );
        } else expect(directorRequests).toHaveLength(0);
        if (directorMode && mode !== "director" && !parallel) {
          const note = "Director unavailable; mention strategy used.";
          expect(JSON.stringify(trace)).toContain(note);
          expect(
            execution.result.runtimeResults.find(
              (result) => result.runtimeId === "chat-mode-narrator/plan",
            )?.output,
          ).toMatchObject({
            status: "available",
            actors: [
              { character: "Mara", reason: note },
              { character: "Ivo", reason: note },
            ],
          });
        }
        if (inherited) {
          expect(actorWorldReads).toBe(2);
          expect(
            execution.commit.results.some(
              (r) => r.runtimeId === "replacement-actor/play",
            ),
          ).toBe(false);
        }
        if (["one-fails", "inherited-world-failure"].includes(mode))
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
