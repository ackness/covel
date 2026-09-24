import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { LLMAdapter, LLMResponse, RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { collectExecutionJournal } from "../src/execution-journal.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { PostLLMResponsePayload } from "../src/hooks/wire-helpers.js";

const story: RuntimeManifest = {
  name: "third-party-story",
  pluginId: "third-party-story",
  description: "Synthetic story engine",
  stage: "narrative",
  runtimeType: "agent",
  outputKind: "story",
  capabilities: ["narrative-engine"],
  tools: { builtin: ["emit-event"] },
};
const text = (content: string): LLMResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});

async function run(replies: LLMResponse[], maxSteps = 6) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "review",
    status: "active",
    phase: "playing",
    activePlugins: [story.pluginId],
    setupRuntimes: {},
    completedPlayerTurns: 1,
    createdAt: now,
    updatedAt: now,
  });
  const pipeline = createHookPipeline();
  pipeline.register({
    id: "buffer",
    pluginId: story.pluginId,
    event: "PreLLMCall",
    handler: async () => ({ action: "continue", replace: { stream: false } }),
  });
  pipeline.register<PostLLMResponsePayload>({
    id: "review",
    pluginId: story.pluginId,
    event: "PostLLMResponse",
    handler: async (_ctx, payload) => {
      expect(payload.messages.some((message) => message.role === "user")).toBe(
        true,
      );
      return payload.response.content?.startsWith("Rejected")
        ? {
            action: "continue",
            replace: { correction: "Use the selected perspective." },
          }
        : { action: "continue" };
    },
  });
  const generate = vi.fn<LLMAdapter["generate"]>(
    async () => replies.shift() ?? text("Rejected again"),
  );
  const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>();
  const toolExecutor = {
    execute: vi.fn(),
    getToolInfo: () => ({
      name: "emit-event",
      description: "test",
      jsonSchema: { type: "object" },
    }),
  };
  const result = await executeTurn(
    {
      sessionId: "review",
      turnId: "turn",
      playerMessage: "Continue",
      origin: "player",
    },
    [{ ...story, maxSteps }],
    {
      store,
      hookPipeline: pipeline,
      llm: { generate, stream },
      toolExecutor,
      onDelta: vi.fn(),
      loadRuntime: async () => ({
        manifest: { ...story, maxSteps },
        promptTemplate: "Continue the scene.",
      }),
    },
  );
  const committed = await finalizeExecution({
    store,
    sessionId: "review",
    runtimes: [story],
    results: result.runtimeResults,
    executionContext: {
      executionId: "turn",
      origin: "player",
      countPolicy: "complete-player-turn",
      logicalTurnId: "logical-turn",
    },
    turnIds: ["turn"],
    sessionClock: { now },
    journalMessages: collectExecutionJournal(result),
  });
  return { result, committed, generate, stream, toolExecutor, store };
}

describe("plugin response validation", () => {
  it("corrects before dispatch, buffers output, and keeps only the accepted story", async () => {
    const rejected = {
      ...text("Rejected draft"),
      toolCalls: [{ id: "unexecuted", name: "emit-event", arguments: "{}" }],
    };
    const { result, generate, stream, toolExecutor } = await run([
      rejected,
      text("I watch the harbor."),
    ]);
    expect(stream).not.toHaveBeenCalled();
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
    const retry = generate.mock.calls[1]![0].messages;
    expect(retry.at(-1)?.content).toContain("Use the selected perspective");
    expect(retry.at(-1)?.content).toContain("resend the complete response");
    expect(retry.flatMap((message) => message.toolCalls ?? [])).toEqual([]);
    expect(result.runtimeResults[0]).toMatchObject({
      status: "success",
      output: { narrativeOutput: "I watch the harbor." },
    });
  });
  it("fails after two corrections instead of publishing a rejected draft", async () => {
    const { result, committed, generate, store } = await run([]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.runtimeResults[0]).toMatchObject({
      status: "failed",
      output: null,
    });
    expect(result.runtimeResults[0]?.error).toContain(
      "Response validation failed",
    );
    expect(committed.status).toBe("failed");
    expect(await store.listMessages("review")).toEqual([]);
    expect(await store.listTurnMessages("review")).toEqual([]);
    expect((await store.getSession("review"))?.completedPlayerTurns).toBe(1);
  });

  it("respects a smaller runtime step budget when corrections are requested", async () => {
    const { result, generate, committed } = await run([], 1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(committed.status).toBe("failed");
  });
});
