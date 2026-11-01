import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LLMAdapter, LLMResponse, RuntimeManifest } from "@covel/shared";
import { storyOutputJsonSchema } from "@covel/shared";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
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
  outputContract: "narrative-engine@2",
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
  const onDelta = vi.fn(
    async (_delta: { textDelta: string; reset?: true }) => undefined,
  );
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
      onDelta,
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
    onDelta,
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
        text(
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
    "adds localized JSON feedback to an existing blank rejection (%s, %j, rewritten: %s)",
    async (locale, content, rewriteBlank) => {
      const replacement = JSON.stringify({
        segments: [{ kind: "narration", text: "Rain falls." }],
      });
      const { result, generate, reviews } = await run(
        [{ ...text(""), content }, text(replacement)],
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
      expect(request.responseFormat?.type).toBe("json_schema");
      // This correction spends review budget and keeps the normal tool surface.
      expect(request.tools?.length).toBeGreaterThan(0);
      const correction = String(request.messages.at(-1)?.content);
      expect(correction).toContain(
        "Write the story from the selected perspective.",
      );
      if (locale === "zh-CN") {
        expect(correction).toMatch(/空白|为空/);
        expect(correction).toContain("未返回 JSON 对象");
        expect(correction).toContain("完整对象");
        expect(correction).not.toMatch(/empty|whitespace|no JSON/i);
      } else {
        expect(correction).toMatch(/empty or whitespace-only/i);
        expect(correction).toMatch(/no JSON object was returned/i);
        expect(correction).toMatch(/complete object.*schema.*segments/i);
      }
      if (rewriteBlank) {
        expect(request.messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: " \n ",
            reasoningContent: "Reviewed reasoning.",
            providerContinuation: expect.any(Object),
          }),
        );
        expect(
          request.messages.some((message) => message.content === content),
        ).toBe(false);
      }
    },
  );

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
        delta.textDelta,
        delta.reset ?? false,
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
    // The one step, then the finalizer, whose draft is rejected as well.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.runtimeResults[0]?.status).toBe("failed");
    expect(result.runtimeResults[0]?.stop).toEqual({ reason: "max-steps" });
    expect(committed.status).toBe("failed");
  });
});
