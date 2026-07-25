/**
 * E2E integration test: TurnExecutor with Mock LLM.
 *
 * Verifies the complete pipeline:
 * Plugin discovery → Load → Trigger → Schedule → Context → LLM call → Result
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { tool } from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";
import { z } from "zod";

// ── Mock LLM ─────────────────────────────────────────────────────

class MockLLM implements LLMAdapter {
  calls: Array<{ messages: readonly { role: string; content: string }[] }> = [];
  response: LLMResponse = {
    content:
      "你踏入了黑暗的森林，空气中弥漫着腐叶和泥土的气息。远处传来一声低沉的吼叫，你的手不自觉地握紧了腰间的短剑。",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50 },
  };

  async generate(params: {
    messages: readonly { role: string; content: string }[];
  }): Promise<LLMResponse> {
    this.calls.push({ messages: params.messages });
    return this.response;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "我走进森林",
    ...overrides,
  };
}

/**
 * Create a memory store primed with one prior player message so that
 * `turnNumber >= 1` and main-loop runtimes (priority 100-1000) survive
 * the band-filter. Tests exercising Pre-Game runtimes should skip this
 * and use a fresh empty store.
 */
async function createMainLoopStore(sessionId: string = "sess-1") {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "prior-player-0",
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("TurnExecutor E2E", () => {
  let mockLLM: MockLLM;
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;

  beforeEach(async () => {
    mockLLM = new MockLLM();

    // Discover and load the narrator plugin
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const narratorDiscovery = discoveries.find((d) => d.id === "narrator");
    expect(narratorDiscovery).toBeDefined();

    const manifests = await loadPluginManifest(narratorDiscovery!);
    expect(manifests.length).toBe(1);

    narratorManifest = manifests[0].manifest;
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: manifests[0].promptTemplate,
    };
  });

  it("should discover narrator from plugins/", () => {
    expect(narratorManifest.name).toBe("narrator");
    expect(narratorManifest.stage).toBe("narrative");
    expect(narratorManifest.pluginType).toBe("core-plugin");
  });

  it("should execute a turn with narrator and get narrative output", async () => {
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(makeTurnInput(), [narratorManifest], deps);

    expect(result.turnId).toBe("turn-1");
    expect(result.sessionId).toBe("sess-1");
    expect(result.runtimeResults).toHaveLength(1);

    const narratorResult = result.runtimeResults[0];
    expect(narratorResult.status).toBe("success");
    expect(narratorResult.pluginId).toBe("narrator");
    expect(narratorResult.output).toBeDefined();
    expect(
      (narratorResult.output as Record<string, unknown>).narrativeOutput,
    ).toContain("黑暗的森林");
  });

  it("should trim trailing meta choice prompts from story output", async () => {
    mockLLM.response = {
      content:
        "你望向雾中的栈桥，听见远处传来钟声。\n\n**现在，你需要做出决定。**",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(makeTurnInput(), [narratorManifest], deps);
    const narratorResult = result.runtimeResults[0]!;
    expect(
      (narratorResult.output as Record<string, unknown>).narrativeOutput,
    ).toBe("你望向雾中的栈桥，听见远处传来钟声。");
  });

  it("passes the player message via user role only, never the system prompt ", async () => {
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store: await createMainLoopStore("sess-1"),
    };

    await executeTurn(
      makeTurnInput({ playerMessage: "我攻击巨龙" }),
      [narratorManifest],
      deps,
    );

    // Verify the LLM was called
    expect(mockLLM.calls).toHaveLength(1);

    // Player input must never be interpolated into the system prompt — it
    // rides the user role exclusively (prompt-injection guardrail).
    const systemMsg = mockLLM.calls[0].messages.find(
      (m) => m.role === "system",
    );
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).not.toContain("我攻击巨龙");

    // Current turn's user message should be the last user message.
    const userMessages = mockLLM.calls[0].messages.filter(
      (m) => m.role === "user",
    );
    expect(userMessages.length).toBeGreaterThan(0);
    expect(userMessages[userMessages.length - 1]!.content).toBe("我攻击巨龙");
  });

  it("should handle multiple runtimes in priority order", async () => {
    const preNarrator: RuntimeManifest = {
      name: "pre-process",
      description: "Pre-turn processing",
      stage: "pre-turn",
    };

    const preLoaded: LoadedRuntime = {
      manifest: preNarrator,
      promptTemplate: "You are a pre-processor.",
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async (manifest) => {
        if (manifest.name === "narrator") return narratorLoaded;
        if (manifest.name === "pre-process") return preLoaded;
        return undefined;
      },
      llm: mockLLM,
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest, preNarrator], // Deliberately out of priority order
      deps,
    );

    expect(result.runtimeResults).toHaveLength(2);

    // LLM should be called twice (once for pre-process at 300, once for narrator at 500)
    expect(mockLLM.calls).toHaveLength(2);
  });

  it("applies API model override only to story runtimes", async () => {
    const storyManifest: RuntimeManifest = {
      name: "story-runtime",
      pluginId: "story-runtime",
      description: "Story runtime",
      stage: "narrative",
      outputKind: "story",
      model: "story",
    };
    const helperManifest: RuntimeManifest = {
      name: "helper-runtime",
      pluginId: "helper-runtime",
      description: "Helper runtime",
      stage: "post-turn",
      model: "plugin",
    };

    const storyLoaded: LoadedRuntime = {
      manifest: storyManifest,
      promptTemplate: "Story runtime prompt.",
    };
    const helperLoaded: LoadedRuntime = {
      manifest: helperManifest,
      promptTemplate: "Helper runtime prompt.",
    };

    const resolveCalls: Array<{ name: string; override: string | undefined }> =
      [];
    const resolveModel = vi.fn(
      (manifest: RuntimeManifest, override?: string) => {
        resolveCalls.push({ name: manifest.name, override });
        return override ?? manifest.model;
      },
    );

    const deps: TurnExecutorDeps = {
      loadRuntime: async (manifest) =>
        manifest.name === "story-runtime" ? storyLoaded : helperLoaded,
      llm: mockLLM,
      resolveModel,
      store: await createMainLoopStore("sess-1"),
    };

    await executeTurn(makeTurnInput(), [storyManifest, helperManifest], deps, {
      maxSteps: 1,
    });

    // Stage barrier: story-runtime (priority 500 → narrative stage) runs before
    // helper-runtime (priority 550 → post-turn stage). Order is incidental to
    // this test — the assertion pins which runtime gets which override.
    expect(resolveCalls).toEqual([
      { name: "story-runtime", override: undefined },
      { name: "helper-runtime", override: undefined },
    ]);

    mockLLM.calls.length = 0;
    resolveCalls.length = 0;

    await executeTurn(
      { ...makeTurnInput(), playerMessage: "继续前进", modelOverride: "e2e3" },
      [storyManifest, helperManifest],
      deps,
      { maxSteps: 1 },
    );

    expect(resolveCalls).toEqual([
      { name: "story-runtime", override: "e2e3" },
      { name: "helper-runtime", override: undefined },
    ]);
  });

  it("retries once when the provider rejects malformed tool-call arguments", async () => {
    const store = await createMainLoopStore("sess-1");
    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");
    const presentableTool = tool({
      name: "generate-guide",
      description: "Builds a guide UI block",
      parameters: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({
        topic,
        categories: [{ style: "safe", suggestions: ["先观察周围环境"] }],
        ui: [
          {
            type: "action-guide",
            topic,
            categories: [{ style: "safe", suggestions: ["先观察周围环境"] }],
          },
        ],
      }),
    });

    const manifest: RuntimeManifest = {
      name: "retry-guide",
      pluginId: "retry-guide",
      description: "Guide runtime with retryable tool-call error",
      stage: "post-turn",
      tools: { local: ["./tools/generate-guide.js"] },
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "Generate guidance.",
    };

    let callCount = 0;
    const llm: LLMAdapter = {
      async generate() {
        callCount++;
        if (callCount === 1) {
          throw new Error(
            '[openai-chat] HTTP 400 — <400> InternalError.Algo.InvalidParameter: The "function.arguments" parameter of the code model must be in JSON format.',
          );
        }
        if (callCount === 2) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-retry-guide",
                name: "generate-guide",
                arguments: JSON.stringify({ topic: "探查前准备" }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: null,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm,
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "generate-guide" ? presentableTool : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps, {
      maxSteps: 2,
    });
    expect(callCount).toBe(3);
    expect(result.runtimeResults[0]?.status).toBe("success");
  });

  it("should handle LLM failure gracefully", async () => {
    const failingLLM: LLMAdapter = {
      async generate() {
        throw new Error("LLM API Error: rate limited");
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: failingLLM,
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(makeTurnInput(), [narratorManifest], deps);

    // Turn should still complete, but narrator result should be failed
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0].status).toBe("failed");
    expect(result.runtimeResults[0].error).toContain("rate limited");
  });

  it("should skip runtimes that do not trigger", async () => {
    const manualRuntime: RuntimeManifest = {
      name: "manual-only",
      description: "Only runs when manually triggered",
      stage: "post-turn",
      trigger: { type: "manual" },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(
      makeTurnInput(),
      [narratorManifest, manualRuntime],
      deps,
    );

    // Only narrator should run (manual-only skipped because isManualTrigger is false)
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0].pluginId).toBe("narrator");
  });

  it("should save player and runtime messages to store when store is provided", async () => {
    const store = await createMainLoopStore("sess-msg");

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store,
    };

    await executeTurn(
      makeTurnInput({ sessionId: "sess-msg", playerMessage: "我走进森林" }),
      [narratorManifest],
      deps,
    );

    const messages = await store.listTurnMessages("sess-msg");

    // Should have at least 2 messages: player message + runtime output
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // The current turn's player message is the last player message appended.
    const playerMessages = messages.filter((m) => m.sourceType === "player");
    expect(playerMessages.length).toBeGreaterThan(0);
    const playerMsg = playerMessages[playerMessages.length - 1]!;
    expect(playerMsg.role).toBe("user");
    expect(playerMsg.content).toBe("我走进森林");

    // Second message should be the runtime output
    const runtimeMsg = messages.find((m) => m.sourceType === "runtime");
    expect(runtimeMsg).toBeDefined();
    expect(runtimeMsg!.role).toBe("assistant");
    expect(runtimeMsg!.name).toBe("narrator");
    expect(runtimeMsg!.content).toContain("黑暗的森林");
  });

  it("should promote presentable tool output when a runtime stops without final text", async () => {
    const store = await createMainLoopStore("sess-1");
    const presentableTool = tool({
      name: "generate-guide",
      description: "Builds a guide UI block",
      parameters: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({
        topic,
        categories: [
          { style: "safe", suggestions: ["先观察周围灵气流向"] },
          { style: "creative", suggestions: ["借水雾掩护靠近入口"] },
        ],
        ui: [
          {
            type: "action-guide",
            topic,
            categories: [
              { style: "safe", suggestions: ["先观察周围灵气流向"] },
              { style: "creative", suggestions: ["借水雾掩护靠近入口"] },
            ],
          },
        ],
      }),
    });
    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");

    const guideManifest: RuntimeManifest = {
      name: "test-guide",
      pluginId: "test-guide",
      description: "Tool-only guide runtime",
      stage: "post-turn",
      tools: { local: ["./tools/generate-guide.js"] },
    };
    const guideLoaded: LoadedRuntime = {
      manifest: guideManifest,
      promptTemplate: "Generate action guidance.",
    };

    let llmCallCount = 0;
    const guideLLM: LLMAdapter = {
      async generate() {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-guide-1",
                name: "generate-guide",
                arguments: JSON.stringify({ topic: "探查百灵沼泽入口" }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: null,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => guideLoaded,
      llm: guideLLM,
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "generate-guide" ? presentableTool : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [guideManifest], deps);
    const guideResult = result.runtimeResults[0]!;

    expect(guideResult.status).toBe("success");
    expect(guideResult.output).toMatchObject({
      topic: "探查百灵沼泽入口",
      categories: expect.any(Array),
      ui: expect.any(Array),
    });
    expect(
      (guideResult.output as Record<string, unknown>).narrativeOutput,
    ).toBeUndefined();
  });

  it("should suppress plain-language final text after tool calls for system runtimes", async () => {
    const store = await createMainLoopStore("sess-1");
    const presentableTool = tool({
      name: "generate-guide",
      description: "Builds a guide state payload",
      parameters: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({
        topic,
        categories: [{ style: "safe", suggestions: ["先观察周围环境"] }],
      }),
    });
    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");

    const manifest: RuntimeManifest = {
      name: "test-system-guide",
      pluginId: "test-system-guide",
      description: "System runtime that should not leak prose after tool calls",
      stage: "post-turn",
      outputKind: "system",
      tools: { local: ["./tools/generate-guide.js"] },
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "Generate guidance and stop.",
    };

    let llmCallCount = 0;
    const llm: LLMAdapter = {
      async generate() {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-system-guide-1",
                name: "generate-guide",
                arguments: JSON.stringify({ topic: "探查百灵沼泽入口" }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        return {
          content: "先给玩家解释局势，再补一组建议。",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm,
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "generate-guide" ? presentableTool : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);
    const runtimeResult = result.runtimeResults[0]!;

    expect(runtimeResult.status).toBe("success");
    expect(runtimeResult.output).toMatchObject({
      topic: "探查百灵沼泽入口",
      categories: expect.any(Array),
    });
    expect(
      (runtimeResult.output as Record<string, unknown>).narrativeOutput,
    ).toBeUndefined();
  });

  it("should fail when a runtime exhausts tool steps without producing final output", async () => {
    const store = await createMainLoopStore("sess-1");
    const lookupTool = tool({
      name: "world-dimension-get",
      description: "Returns lore snippets",
      parameters: z.object({ dimension: z.string() }),
      execute: async ({ dimension }) => ({
        _text: `Loaded ${dimension}`,
        dimension,
        found: true,
      }),
    });
    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");

    const lookupManifest: RuntimeManifest = {
      name: "test-narrator",
      pluginId: "test-narrator",
      description: "Narrative runtime that keeps calling tools",
      stage: "narrative",
      tools: { builtin: ["world-dimension-get"] },
    };
    const lookupLoaded: LoadedRuntime = {
      manifest: lookupManifest,
      promptTemplate: "Narrate after reading lore.",
    };

    const loopingLLM: LLMAdapter = {
      async generate() {
        return {
          content: null,
          toolCalls: [
            {
              id: `tc-lookup-${Math.random()}`,
              name: "world-dimension-get",
              arguments: JSON.stringify({ dimension: "geography" }),
            },
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => lookupLoaded,
      llm: loopingLLM,
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "world-dimension-get" ? lookupTool : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [lookupManifest], deps, {
      maxSteps: 3,
    });
    const runtimeResult = result.runtimeResults[0]!;

    expect(runtimeResult.status).toBe("failed");
    expect(runtimeResult.output).toBeNull();
    expect(runtimeResult.error).toContain(
      "exhausted the tool loop after 3 steps",
    );
    expect(runtimeResult.toolCalls).toHaveLength(3);
  });

  it("should fail when tool validation errors end without any final output", async () => {
    const store = await createMainLoopStore("sess-1");
    const strictTool = tool({
      name: "generate-guide",
      description: "Requires at least one suggestion",
      parameters: z.object({
        topic: z.string(),
        suggestions: z.array(z.string()).min(1),
      }),
      execute: async ({ topic, suggestions }) => ({ topic, suggestions }),
    });
    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");

    const manifest: RuntimeManifest = {
      name: "test-guide-invalid",
      pluginId: "test-guide-invalid",
      description: "Guide runtime with invalid tool args",
      stage: "post-turn",
      tools: { local: ["./tools/generate-guide.js"] },
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: "Generate guidance.",
    };

    let llmCallCount = 0;
    const invalidGuideLLM: LLMAdapter = {
      async generate(params) {
        llmCallCount++;
        const hasToolResult = params.messages.some((m) => m.role === "tool");
        if (hasToolResult) {
          return {
            content: null,
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 5 },
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "tc-invalid-guide",
              name: "generate-guide",
              arguments: JSON.stringify({
                topic: "探查百灵沼泽",
                suggestion_list: ["错误字段"],
              }),
            },
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm: invalidGuideLLM,
      store,
      toolExecutor: createToolExecutor({
        findTool: (name) =>
          name === "generate-guide" ? strictTool : undefined,
        store,
      }),
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);
    const runtimeResult = result.runtimeResults[0]!;

    expect(llmCallCount).toBe(2);
    expect(runtimeResult.status).toBe("failed");
    expect(runtimeResult.error).toContain(
      "stopped without final output after a tool failure",
    );
    expect(runtimeResult.error).toContain("generate-guide");
  });

  it("should pass message history to context builder", async () => {
    const store = createMemoryStore();

    // Pre-populate store with history
    await store.appendTurnMessage({
      id: "hist-1",
      sessionId: "sess-hist",
      turnId: "turn-0",
      sourceType: "player",
      role: "user",
      content: "Previous player message",
      order: 0,
      createdAt: "2024-01-01T00:00:00Z",
    });
    await store.appendTurnMessage({
      id: "hist-2",
      sessionId: "sess-hist",
      turnId: "turn-0",
      sourceType: "runtime",
      sourcePluginId: "narrator",
      role: "assistant",
      name: "narrator",
      content: "Previous narrator response",
      order: 500,
      createdAt: "2024-01-01T00:00:01Z",
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      store,
    };

    await executeTurn(
      makeTurnInput({
        sessionId: "sess-hist",
        turnId: "turn-1",
        playerMessage: "继续探索",
      }),
      [narratorManifest],
      deps,
    );

    // Verify LLM received history messages before current user message
    expect(mockLLM.calls).toHaveLength(1);
    const llmMessages = mockLLM.calls[0].messages;

    // Should have: system + history(user) + history(assistant) + current user
    expect(llmMessages.length).toBeGreaterThanOrEqual(4);

    // Find messages by content to verify history is included
    const historyUser = llmMessages.find(
      (m) => m.content === "Previous player message",
    );
    expect(historyUser).toBeDefined();
    expect(historyUser!.role).toBe("user");

    const historyAssistant = llmMessages.find(
      (m) => m.content === "Previous narrator response",
    );
    expect(historyAssistant).toBeDefined();
    expect(historyAssistant!.role).toBe("assistant");

    const currentUser = llmMessages.find(
      (m) => m.role === "user" && m.content === "继续探索",
    );
    expect(currentUser).toBeDefined();
    expect(llmMessages.filter((m) => m.content === "继续探索")).toHaveLength(1);
  });
});

// ── Interaction protocol tests ──────────────────────────────────

describe("TurnExecutor _interaction protocol", () => {
  it("should detect _interaction from tool results and populate pendingInputs", async () => {
    const store = await createMainLoopStore("sess-1");
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const charDiscovery = discoveries.find((d) => d.id === "char-creator")!;
    const charManifests = await loadPluginManifest(charDiscovery);
    // player-init is the runtime that declares `create-form`. Picking
    // `charManifests[0]` used to grab character-tracker instead, and the
    // test only passed back when the executor let any runtime call any
    // builtin regardless of its declaration.
    const charManifest = charManifests.find(
      (m) => m.manifest.name === "char-creator/player-init",
    )!.manifest;
    const charLoaded = await loadRuntime(charDiscovery, charManifest.name);

    // MockLLM that calls create-form (which now returns _interaction)
    const mockLLM = new MockLLM();
    let callCount = 0;
    mockLLM.generate = async (params) => {
      callCount++;
      const hasToolResult = params.messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        return {
          content: "表单已创建",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 50, outputTokens: 10 },
        };
      }
      return {
        content: "角色创建...",
        toolCalls: [
          {
            id: "tc-1",
            name: "create-form",
            arguments: JSON.stringify({
              formId: "test-form",
              title: "创建角色",
              fields: [
                {
                  type: "text",
                  name: "charName",
                  label: "角色名",
                  required: true,
                },
              ],
              submitLabel: "确认",
              narrativeTemplate: "你的名字是 {{charName}}。",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };

    const { createToolExecutor } =
      await import("../src/agent-loop/tool-executor.js");
    const { builtinUITools } = await import("@covel/tools");
    const toolMap = new Map();
    for (const t of builtinUITools) toolMap.set(t.name, t);

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => charLoaded,
      llm: mockLLM as LLMAdapter,
      store,
      toolExecutor: createToolExecutor({
        findTool: (n) => toolMap.get(n),
        store,
      }),
    };

    // Strip the upstream gate for this unit test — the real player-init
    // declares turn-scoped `needs: [pregame, world-init/schema-gen]` so the
    // framework skips it when those aren't scheduled. This test focuses on the
    // interaction protocol in isolation and doesn't wire in the setup chain.
    const isolatedManifest = {
      ...charManifest,
      needs: undefined,
      needs: undefined,
    };
    const result = await executeTurn(makeTurnInput(), [isolatedManifest], deps);

    // Should have pendingInputs with the interaction protocol
    expect(result.pendingInputs).toBeDefined();
    expect(result.pendingInputs!.length).toBeGreaterThanOrEqual(1);

    const pi = result.pendingInputs![0];
    expect(pi.interaction).toBeDefined();
    expect(pi.interaction.type).toBe("form");
    expect(pi.interaction.interactionId).toBe("test-form");
    expect(pi.form).toBeDefined();
    expect((pi.form as Record<string, unknown>).interactionId).toBe(
      "test-form",
    );
  });
});
