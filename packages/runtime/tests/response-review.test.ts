import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
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
  outputContract: "narrative-engine@1",
  tools: { builtin: ["emit-event"] },
};
const text = (content: string): LLMResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});

async function run(
  replies: LLMResponse[],
  maxSteps = 6,
  { streaming = false, locale = undefined as string | undefined } = {},
) {
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
  if (!streaming)
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
  const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>(async function* () {
    const reply = replies.shift() ?? text("Rejected again");
    if (reply.content) yield { type: "text-delta", textDelta: reply.content };
    for (const call of reply.toolCalls) yield { type: "tool-call", ...call };
    yield {
      type: "done",
      finishReason: reply.finishReason,
      usage: reply.usage,
    };
  });
  const onDelta = vi.fn(async () => undefined);
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
      ...(locale ? { locale } : {}),
    },
    [{ ...story, maxSteps }],
    {
      store,
      hookPipeline: pipeline,
      llm: { generate, stream },
      toolExecutor,
      onDelta,
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
  return { result, committed, generate, stream, toolExecutor, store, onDelta };
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
  it("tells a Chinese session in Chinese that the draft was not accepted", async () => {
    const { generate } = await run(
      [text("Rejected draft"), text("I watch the harbor.")],
      6,
      { locale: "zh-CN" },
    );
    const [rejection, correction] = String(
      generate.mock.calls[1]![0].messages.at(-1)?.content,
    ).split("\n");
    expect(rejection).toContain("草稿未被接受");
    expect(rejection).not.toMatch(/[A-Za-z]/);
    // The plugin's own correction follows, as the plugin wrote it.
    expect(correction).toBe("Use the selected perspective.");
  });
  it("sends a rejected draft back with its reasoning", async () => {
    const providerContinuation = {
      protocol: "openai-chat-v1",
      model: "fixture",
      items: [{ type: "reasoning", field: "reasoning" }],
    };
    const { generate } = await run([
      {
        ...text("Rejected draft"),
        reasoningContent: "Plan the scene.",
        providerContinuation,
      },
      text("I watch the harbor."),
    ]);
    const retry = generate.mock.calls[1]![0].messages;
    // Thinking-mode providers reject an assistant turn without its reasoning.
    expect(
      retry.find((message) => message.content === "Rejected draft"),
    ).toMatchObject({
      role: "assistant",
      reasoningContent: "Plan the scene.",
      providerContinuation,
    });
  });
  it("streams drafts and resets the rejected one before the accepted story", async () => {
    const { result, stream, onDelta } = await run(
      [text("Rejected draft"), text("I watch the harbor.")],
      6,
      { streaming: true },
    );
    expect(stream).toHaveBeenCalledTimes(2);
    expect(
      onDelta.mock.calls.map(([delta]) => [
        (delta as { textDelta: string }).textDelta,
        (delta as { reset?: true }).reset ?? false,
      ]),
    ).toEqual([
      ["Rejected draft", false],
      ["", true],
      ["I watch the harbor.", false],
    ]);
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
