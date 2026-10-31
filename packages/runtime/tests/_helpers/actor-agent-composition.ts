import { expect } from "vitest";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import {
  CHARACTER_ACTOR_CONTRACT,
  storyOutputJsonSchema,
  type LLMAdapter,
  type LLMResponse,
  type RuntimeManifest,
  type SubscriptionEvent,
} from "@covel/shared";
import { delegateTool } from "@covel/tools";
import {
  executeTurn,
  commitExecution,
  createToolExecutor,
  createTurnEmitter,
} from "../../src/index.js";
import { PluginServiceRegistry } from "../../src/plugin-services.js";
import { policies } from "./orchestration-fixture.js";
import {
  prose,
  toolCall,
  expectMatchedToolCalls,
} from "./agent-loop-fixture.js";

export const compositionScenarios = [
  "plain",
  "google-generative-ai-v1",
  "openai-responses-v1",
  "anthropic-messages-v1",
  "compacted",
] as const;

export async function assertPrivateActorComposition({
  concealed,
  scenario,
  inspectTrace,
}: {
  concealed: boolean;
  scenario: (typeof compositionScenarios)[number];
  inspectTrace?: (store: DataStore, sessionId: string) => Promise<void>;
}) {
  const compacted = scenario === "compacted";
  const native = scenario !== "plain" && !compacted;
  const continuations: LLMResponse[] = [];
  const withContinuation = (response: LLMResponse, reasoning: string) => {
    if (!native) return response;
    const items = response.toolCalls.map((call) =>
      scenario === "google-generative-ai-v1"
        ? {
            functionCall: {
              id: call.id,
              name: call.name,
              args: JSON.parse(call.arguments),
            },
          }
        : scenario === "openai-responses-v1"
          ? {
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: call.arguments,
            }
          : {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments),
            },
    );
    const result: LLMResponse = {
      ...response,
      reasoningContent: reasoning,
      providerContinuation: {
        protocol: scenario,
        model: "fixture",
        items: [
          scenario === "google-generative-ai-v1"
            ? { text: reasoning, thought: true }
            : scenario === "openai-responses-v1"
              ? {
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: reasoning }],
                }
              : { type: "thinking", thinking: reasoning, signature: "signed" },
          ...items,
        ],
      },
    };
    continuations.push(structuredClone(result));
    return result;
  };
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
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
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
      if (native && parentCalls >= 3) {
        for (const expected of continuations) {
          const replay = messages.find((message) =>
            message.toolCalls?.some(
              (call) => call.id === expected.toolCalls[0]?.id,
            ),
          );
          expect(replay?.providerContinuation).toEqual(
            expected.providerContinuation,
          );
          expect(replay?.reasoningContent).toBe(expected.reasoningContent);
          expect(replay?.toolCalls).toEqual(expected.toolCalls);
        }
      }
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
        return withContinuation(
          toolCall(
            "delegate",
            {
              brief: "BRIEF-SECRET" + (compacted ? "b".repeat(8_000) : ""),
              target: { contract: CHARACTER_ACTOR_CONTRACT },
              character: "Captain",
              unexpected: true,
            },
            "invalid-actor-call",
          ),
          "PRIVATE-REASONING",
        );
      }
      if (parentCalls === 3) {
        expect(text).toContain("Mara");
        expect(text).not.toContain("semantic-character");
        return withContinuation(
          toolCall(
            "delegate",
            {
              brief: "BRIEF-SECRET" + (compacted ? "b".repeat(8_000) : ""),
              target: { contract: CHARACTER_ACTOR_CONTRACT },
              character: "Captain",
            },
            "actor-call",
          ),
          "PRIVATE-REASONING",
        );
      }
      expect(text).toContain("INTENT-SECRET");
      if (native && parentCalls === 4) {
        return withContinuation(
          toolCall(
            "choose",
            { present: ["Captain"], recentSegments: [] },
            "followup-policy",
          ),
          "INTENT-SECRET",
        );
      }
      if (compacted) {
        const digest = messages.find(
          (message) =>
            message.role === "system" &&
            String(message.content).includes("Earlier tool steps"),
        );
        expect(digest?.content).toContain("BRIEF-SECRET");
        if (parentCalls === 4) {
          return toolCall(
            "delegate",
            {
              brief: "BRIEF-SECRET" + "c".repeat(8_000),
              target: { contract: CHARACTER_ACTOR_CONTRACT },
              character: "Captain",
            },
            "second-actor-call",
          );
        }
        // The successful delegate, not just the rejected call, was condensed.
        expect(
          messages.some((message) =>
            message.toolCalls?.some((call) => call.id === "actor-call"),
          ),
        ).toBe(false);
      }
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
      ...(compacted
        ? {
            estimator: (text: string) => text.length,
            contextBudget: { maxInputTokens: 20_000, reservedForResponse: 100 },
          }
        : {}),
      services,
      llm,
      emitter: createTurnEmitter({ store, eventBus, sessionId, turnId }),
      toolExecutor: createToolExecutor({
        store,
        findTool: (name) => (name === "delegate" ? delegateTool : undefined),
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
  expect(parentCalls).toBe(native || compacted ? 5 : 4);
  expect(actorCalls).toBe(compacted ? 2 : 1);
  const committed = await commitExecution({
    store,
    eventBus,
    execution,
    completion: { kind: "turn", turnId, durationMs: 0 },
  });
  expect(committed.status).toBe("committed");
  const traces = await store.listTraceEvents(sessionId);
  const requests = traces.filter((event) => event.type === "llm.calling");
  expect(requests.length).toBeGreaterThanOrEqual(parentCalls);
  if (compacted) {
    expect(
      traces.some(
        (event) =>
          event.type === "context.pruned" &&
          Number(
            (event.payload as Record<string, unknown>).collapsedStepCount,
          ) > 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(requests)).toContain("Earlier tool steps");
  }
  const persisted = JSON.stringify({
    events,
    results: await store.queryTurnResults(sessionId, { turnId }),
    trace: traces,
    messages: await store.listMessages(sessionId),
  });
  expect(persisted).not.toMatch(/INTENT-SECRET|BRIEF-SECRET|PRIVATE-REASONING/);
  expect(
    committed.events.some((event) => event.type === "narrative.completed"),
  ).toBe(true);
  expect(events.some((event) => event.type === "runtime.failed")).toBe(false);
  await inspectTrace?.(store, sessionId);
  await store.close();
}
