import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { StreamEvent } from "../src/types.js";

const context = { profile: {} as never, preset: null, mode: "text" as const };
const request = {
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
};

function stubJson(payload: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }),
  );
}

function stubSse(events: Array<Record<string, unknown>>): void {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              events
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("") + "data: [DONE]\n\n",
            ),
          );
          controller.close();
        },
      }),
    }),
  );
}

async function readDone(
  stream: AsyncIterable<StreamEvent>,
): Promise<Extract<StreamEvent, { type: "done" }>> {
  for await (const event of stream) {
    if (event.type === "done") return event;
  }
  throw new Error("stream did not emit done");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt cache usage normalization", () => {
  it("reads OpenAI Chat cached and cache-write input tokens", async () => {
    stubJson({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: {
          cached_tokens: 80,
          cache_write_tokens: 20,
        },
      },
    });

    const result = await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1" },
      request,
      context,
    );

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 20,
    });
  });

  it("requests and preserves usage for OpenAI Chat streaming", async () => {
    stubSse([
      { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 75 },
        },
      },
    ]);

    const done = await readDone(
      createOpenAiChatAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1" },
        request,
        { ...context, mode: "stream" },
      ),
    );

    expect(done.usage).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cachedInputTokens: 75,
    });
    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("reads OpenAI Responses cache usage from streaming completion", async () => {
    stubSse([
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 120,
            output_tokens: 12,
            input_tokens_details: {
              cached_tokens: 90,
              cache_write_tokens: 30,
            },
          },
        },
      },
    ]);

    const done = await readDone(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1" },
        request,
        { ...context, mode: "stream" },
      ),
    );

    expect(done.usage).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cachedInputTokens: 90,
      cacheWriteInputTokens: 30,
    });
  });

  it.each([
    ["response.incomplete", "incomplete", "length"],
    ["response.failed", "failed", "error"],
  ])(
    "preserves usage and finish reason for %s streams",
    async (eventType, status, finishReason) => {
      stubSse([
        {
          type: eventType,
          response: {
            status,
            usage: { input_tokens: 17, output_tokens: 9 },
          },
        },
      ]);

      const done = await readDone(
        createOpenAiResponsesAdapter().streamText(
          { baseUrl: "https://api.openai.com/v1" },
          request,
          { ...context, mode: "stream" },
        ),
      );

      expect(done).toEqual({
        type: "done",
        finishReason,
        usage: { inputTokens: 17, outputTokens: 9 },
      });
    },
  );

  it("reads OpenAI Responses cache usage from a non-streaming response", async () => {
    stubJson({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 5,
        input_tokens_details: {
          cached_tokens: 45,
          cache_write_tokens: 5,
        },
      },
    });

    const result = await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1" },
      request,
      context,
    );

    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cachedInputTokens: 45,
      cacheWriteInputTokens: 5,
    });
  });

  it("reads Anthropic cache usage and preserves it through stream deltas", async () => {
    stubSse([
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 40,
            output_tokens: 0,
            cache_read_input_tokens: 32,
            cache_creation_input_tokens: 8,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 6 },
      },
    ]);

    const done = await readDone(
      createAnthropicMessagesAdapter().streamText(
        { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" },
        request,
        { ...context, mode: "stream" },
      ),
    );

    expect(done.usage).toEqual({
      inputTokens: 80,
      outputTokens: 6,
      cachedInputTokens: 32,
      cacheWriteInputTokens: 8,
    });
  });

  it("keeps cache fields optional when a provider does not report them", async () => {
    stubJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const result = await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" },
      request,
      context,
    );

    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it("rejects malformed provider counters at the wire boundary", async () => {
    stubJson({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: -5,
        completion_tokens: 1.5,
        prompt_tokens_details: {
          cached_tokens: -1,
          cache_write_tokens: "not-a-number",
        },
      },
    });

    const result = await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1" },
      request,
      context,
    );

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("clamps cache subsets to the inclusive OpenAI input total", async () => {
    stubJson({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: {
          cached_tokens: 8,
          cache_write_tokens: 8,
        },
      },
    });

    const result = await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1" },
      request,
      context,
    );

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 2,
    });
  });

  it("saturates Anthropic's inclusive input sum at a safe integer", async () => {
    stubJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 2,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 10,
      },
    });

    const result = await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" },
      request,
      context,
    );

    expect(result.usage).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 2,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 10,
    });
  });
});
