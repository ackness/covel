import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  CHARACTER_ACTOR_CONTRACT,
  storyOutputJsonSchema,
  type LLMAdapter,
  type RuntimeManifest,
  type SubscriptionEvent,
} from "@covel/shared";
import { delegateTool } from "@covel/tools";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
  createTurnEmitter,
} from "../src/index.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { policies } from "./_helpers/orchestration-fixture.js";
import {
  prose,
  toolCall,
  expectMatchedToolCalls,
} from "./_helpers/agent-loop-fixture.js";

describe("an agent composes private character replies", () => {
  it.each([false, true])(
    "keeps live intent and valid tool pairing while protecting traces (concealed: %s)",
    async (concealed) => {
      const store = createMemoryStore();
      const sessionId = "scene";
      const turnId = "turn";
      await store.createSession({
        id: sessionId,
        status: "active",
        phase: "playing",
        locale: "en-US",
        activePlugins: ["sample"],
        seats: [],
        setupRuntimes: {},
        completedPlayerTurns: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        metadata: {
          orchestration: {
            turnPolicy: { pluginId: "sample", name: "ensemble" },
          },
        },
      });
      await store.upsertCharacter({
        id: "semantic-character",
        name: "Mara",
        aliases: ["Captain"],
        sessionId,
        type: "npc",
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      const actor: RuntimeManifest = {
        pluginId: "sample",
        name: "sample/actor",
        description: "Actor",
        runtimeType: "agent",
        outputKind: "system",
        subagentOnly: true,
        outputContract: CHARACTER_ACTOR_CONTRACT,
        concealed,
        trigger: { type: "manual" },
      };
      const parent: RuntimeManifest = {
        pluginId: "sample",
        name: "sample/story",
        description: "Story",
        runtimeType: "agent",
        outputKind: "story",
        stage: "narrative",
        tools: {
          builtin: ["delegate"],
          services: [{ contract: "turn-policy@1", name: "choose" }],
        },
      };
      const services = new PluginServiceRegistry({
        list: async () => ["sample"],
        ensure: async () => {},
      });
      for (const policy of policies) services.register("sample", policy);
      const eventBus = createEventBus();
      const events: SubscriptionEvent[] = [];
      eventBus.onEmit((event) => events.push(event));
      let parentCalls = 0;
      let actorCalls = 0;
      const llm: LLMAdapter = {
        generate: async ({ messages, tools }) => {
          expectMatchedToolCalls(messages);
          const text = JSON.stringify(messages);
          if (
            messages.some(
              (message) =>
                message.role === "system" &&
                typeof message.content === "string" &&
                message.content.includes("ACTOR-PROMPT"),
            )
          ) {
            actorCalls++;
            expect(text).not.toMatch(/semantic-character|PARENT-SECRET/);
            expect(text).toContain("Mara");
            return prose(
              JSON.stringify({
                segments: [{ kind: "dialogue", text: "I will listen." }],
                intent: "INTENT-SECRET",
              }),
            );
          }
          parentCalls++;
          if (parentCalls === 1) {
            expect(
              JSON.stringify(tools?.find((tool) => tool.name === "choose")),
            ).not.toContain("characterId");
            return toolCall(
              "choose",
              { present: ["Captain"], recentSegments: [] },
              "policy-call",
            );
          }
          if (parentCalls === 2) {
            return toolCall(
              "delegate",
              {
                target: { contract: CHARACTER_ACTOR_CONTRACT },
                character: "Captain",
                brief: "BRIEF-SECRET",
                unexpected: true,
              },
              "invalid-actor-call",
            );
          }
          if (parentCalls === 3) {
            expect(text).toContain("Mara");
            expect(text).not.toContain("semantic-character");
            return toolCall(
              "delegate",
              {
                target: { contract: CHARACTER_ACTOR_CONTRACT },
                character: "Captain",
                brief: "BRIEF-SECRET",
              },
              "actor-call",
            );
          }
          expect(text).toContain("INTENT-SECRET");
          return prose(
            JSON.stringify({
              segments: [
                { kind: "dialogue", speaker: "Mara", text: "I will listen." },
                { kind: "narration", text: "The conversation continues." },
              ],
            }),
          );
        },
      };
      const execution = await executeTurn(
        {
          sessionId,
          turnId,
          origin: "player",
          playerMessage: "PARENT-SECRET",
          locale: "en-US",
        },
        [parent, actor],
        {
          store,
          services,
          llm,
          emitter: createTurnEmitter({ store, eventBus, sessionId, turnId }),
          toolExecutor: createToolExecutor({
            store,
            findTool: (name) =>
              name === "delegate" ? delegateTool : undefined,
          }),
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate:
              manifest === actor ? "ACTOR-PROMPT" : "Compose a story.",
            ...(manifest === parent
              ? { outputSchema: storyOutputJsonSchema() }
              : {}),
          }),
        },
      );
      expect(execution.result.runtimeResults).toHaveLength(1);
      expect(execution.result.runtimeResults[0]?.status).toBe("success");
      expect(parentCalls).toBe(4);
      expect(actorCalls).toBe(1);
      const committed = await commitExecution({
        store,
        eventBus,
        execution,
        completion: { kind: "turn", turnId, durationMs: 0 },
      });
      expect(committed.status).toBe("committed");
      const persisted = JSON.stringify({
        events,
        results: await store.queryTurnResults(sessionId, { turnId }),
        trace: await store.listTraceEvents(sessionId),
        messages: await store.listMessages(sessionId),
      });
      expect(persisted).not.toMatch(/INTENT-SECRET|BRIEF-SECRET/);
      expect(
        committed.events.some((event) => event.type === "narrative.completed"),
      ).toBe(true);
      expect(events.some((event) => event.type === "runtime.failed")).toBe(
        false,
      );
      await store.close();
    },
  );
});
