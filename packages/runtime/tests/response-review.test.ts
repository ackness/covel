import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LLMAdapter, LLMResponse, RuntimeManifest } from "@covel/shared";
import { storyOutputJsonSchema } from "@covel/shared";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { collectExecutionJournal } from "../src/execution-journal.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { PostLLMResponsePayload } from "../src/hooks/wire-helpers.js";

const responseIsContent = (response: LLMResponse) =>
  !response.toolCalls.some((call) => call.name === "submit-output");
const story: RuntimeManifest = {
  name: "third-party-story",
  pluginId: "third-party-story",
  description: "Synthetic story engine",
  stage: "narrative",
  runtimeType: "agent",
  outputKind: "story",
  outputContract: "narrative-engine@2",
  tools: { builtin: ["emit-event"] },
};
const text = (content: string): LLMResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});

const submitted = (content: string): LLMResponse => ({
  ...text(""),
  toolCalls: [
    {
      id: "submit",
      name: "submit-output",
      arguments: JSON.stringify({ narrativeOutput: content }),
    },
  ],
  finishReason: "tool_calls",
});
const segmented = (content: string): LLMResponse => ({
  ...text(""),
  toolCalls: [{ id: "submit", name: "submit-output", arguments: content }],
  finishReason: "tool_calls",
});

async function run(
  replies: LLMResponse[],
  maxSteps = 6,
  {
    streaming = false,
    locale = undefined as string | undefined,
    structured = false,
    rewriteBlank = false,
  } = {},
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    locale: "en-US",
    id: "review",
    status: "active",
    phase: "playing",
    activePlugins: [story.pluginId],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 1,
    createdAt: now,
    updatedAt: now,
  });
  const pipeline = createHookPipeline();
  let reviews = 0;
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
      reviews += 1;
      expect(payload.messages.some((message) => message.role === "user")).toBe(
        true,
      );
      if (
        structured &&
        responseIsContent(payload.response) &&
        (!payload.response.content?.trim() ||
          (rewriteBlank && payload.response.content.startsWith("Rewrite")))
      ) {
        return {
          action: "continue",
          replace: {
            correction: "Write the story from the selected perspective.",
            ...(rewriteBlank
              ? {
                  response: {
                    ...payload.response,
                    content: " \n ",
                    reasoningContent: "Reviewed reasoning.",
                    providerContinuation: {
                      protocol: "openai-chat-v1",
                      model: "fixture",
                      items: [{ type: "reasoning", field: "reasoning" }],
                    },
                  },
                }
              : {}),
          },
        };
      }
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
  const toolExecutor = {
    execute: vi.fn(),
    getToolInfo: () => ({
      name: "emit-event",
      description: "test",
      annotations: {
        readOnly: false,
        stagesWrites: true,
        idempotent: false,
        concurrencySafe: false,
      },
      jsonSchema: { type: "object" },
    }),
  };
  const result = await runTurnPipeline(
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
      loadRuntime: async () => ({
        manifest: { ...story, maxSteps },
        promptTemplate: "Continue the scene.",
        ...(structured ? { outputSchema: storyOutputJsonSchema() } : {}),
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
  return {
    result,
    committed,
    generate,
    stream,
    toolExecutor,
    store,
    reviews,
  };
}

describe("plugin response validation", () => {
  it("does not call an empty-content tool response a missing JSON answer", async () => {
    const { generate, toolExecutor, result } = await run(
      [
        {
          ...text(""),
          content: null,
          toolCalls: [
            { id: "unexecuted", name: "emit-event", arguments: "{}" },
          ],
        },
        segmented(
          JSON.stringify({
            segments: [{ kind: "narration", text: "Rain falls." }],
          }),
        ),
      ],
      6,
      { structured: true },
    );
    expect(result.runtimeResults[0]?.status).toBe("success");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    const correction = String(
      generate.mock.calls[1]![0].messages.at(-1)?.content,
    );
    expect(correction).toContain(
      "Write the story from the selected perspective.",
    );
    expect(correction).not.toMatch(/empty|whitespace|no JSON/i);
  });

  it.each([
    ["en-US", null, false],
    ["en-US", "", false],
    ["en-US", " \n ", false],
    ["en-US", "Rewrite this draft", true],
    ["zh-CN", " \n ", false],
    ["zh-CN", "Rewrite this draft", true],
  ] as const)(
    "keeps response review separate from missing-submission validation (%s, %j, rewritten: %s)",
    async (locale, content, rewriteBlank) => {
      const replacement = JSON.stringify({
        segments: [{ kind: "narration", text: "Rain falls." }],
      });
      const { result, generate, reviews } = await run(
        [{ ...text(""), content }, segmented(replacement)],
        6,
        { locale, structured: true, rewriteBlank },
      );
      expect(generate).toHaveBeenCalledTimes(2);
      expect(reviews).toBe(2);
      expect(result.runtimeResults[0]).toMatchObject({
        status: "success",
        stop: { reason: "completed" },
      });
      const request = generate.mock.calls[1]![0];
      expect(request.responseFormat).toBeUndefined();
      // This correction spends review budget and keeps the normal tool surface.
      expect(request.tools?.length).toBeGreaterThan(0);
      const correction = String(request.messages.at(-1)?.content);
      expect(correction).toContain(
        "Write the story from the selected perspective.",
      );
      expect(correction).not.toMatch(/no JSON|segments array is missing/);
      if (rewriteBlank)
        expect(request.messages).toContainEqual(
          expect.objectContaining({ role: "assistant", content }),
        );
    },
  );

  it("corrects before dispatch, buffers output, and keeps only the accepted story", async () => {
    const rejected = {
      ...text("Rejected draft"),
      toolCalls: [{ id: "unexecuted", name: "emit-event", arguments: "{}" }],
    };
    const { result, generate, stream, toolExecutor } = await run([
      rejected,
      submitted("I watch the harbor."),
    ]);
    expect(stream).not.toHaveBeenCalled();
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
    const retry = generate.mock.calls[1]![0].messages;
    expect(retry.at(-1)?.content).toContain("Use the selected perspective");

    expect(retry.flatMap((message) => message.toolCalls ?? [])).toEqual(
      rejected.toolCalls,
    );
    expect(result.runtimeResults[0]).toMatchObject({
      status: "success",
      output: { narrativeOutput: "I watch the harbor." },
    });
  });
  it("keeps the reviewer correction unchanged in a Chinese session", async () => {
    const { generate } = await run(
      [text("Rejected draft"), submitted("I watch the harbor.")],
      6,
      { locale: "zh-CN" },
    );
    expect(
      String(generate.mock.calls[1]![0].messages.at(-1)?.content),
    ).toContain("Use the selected perspective.");
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
      submitted("I watch the harbor."),
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
  it("discards a rejected streamed draft before committing the accepted story", async () => {
    const { result, stream, committed, store } = await run(
      [text("Rejected draft"), submitted("I watch the harbor.")],
      6,
      { streaming: true },
    );
    expect(stream).toHaveBeenCalledTimes(2);
    expect(committed.status).toBe("committed");
    const messages = await store.listMessages("review");
    expect(
      messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("Rejected draft");
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
    expect(result.runtimeResults[0]?.error).toContain("review-rejected");
    expect(committed.status).toBe("failed");
    expect(await store.listMessages("review")).toEqual([]);
    expect(await store.listTurnMessages("review")).toEqual([]);
    expect((await store.getSession("review"))?.completedPlayerTurns).toBe(1);
  });

  it("respects a smaller runtime step budget when corrections are requested", async () => {
    const { result, generate, committed } = await run([], 1);
    // The one step, then the finalizer, whose draft is rejected as well.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.stop).toEqual({ reason: "max-steps" });
    expect(committed.status).toBe("failed");
  });
});
