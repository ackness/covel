import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { resolveProviderOptions } from "../src/provider-options.js";
import type { TextGenerationParams } from "../src/types.js";

const context = { profile: {} as never, preset: null, mode: "text" as const };
const OPENAI = "https://api.openai.com/v1";
const RELAY = "https://relay.example.com/v1";
const KEY = "covel-0123456789abcdef0123456789abcdef";

function request(
  providerRequestMetadata?: Record<string, unknown>,
): TextGenerationParams {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    promptCacheKey: KEY,
    ...(providerRequestMetadata ? { providerRequestMetadata } : {}),
  };
}

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

function sentBody(): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const chatReply = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};
const responsesReply = {
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: "ok" }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt_cache_key on the OpenAI wires", () => {
  it("sends the key to api.openai.com on Chat, plain and streamed", async () => {
    stubJson(chatReply);
    await createOpenAiChatAdapter().generateText(
      { baseUrl: OPENAI },
      request(),
      context,
    );
    expect(sentBody().prompt_cache_key).toBe(KEY);

    stubSse([
      { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    for await (const _ of createOpenAiChatAdapter().streamText(
      { baseUrl: OPENAI },
      request(),
      { ...context, mode: "stream" },
    )) {
      // drain
    }
    expect(sentBody().prompt_cache_key).toBe(KEY);
  });

  it("sends the key to api.openai.com on Responses", async () => {
    stubJson(responsesReply);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: OPENAI },
      request(),
      context,
    );
    expect(sentBody().prompt_cache_key).toBe(KEY);
  });

  it("leaves the key out for another endpoint, which may reject the field", async () => {
    stubJson(chatReply);
    await createOpenAiChatAdapter().generateText(
      { baseUrl: RELAY },
      request(),
      context,
    );
    expect(sentBody()).not.toHaveProperty("prompt_cache_key");

    stubJson(responsesReply);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: RELAY },
      request(),
      context,
    );
    expect(sentBody()).not.toHaveProperty("prompt_cache_key");
  });

  it("follows the target's promptCacheKey option and never forwards the option itself", async () => {
    const enabled = resolveProviderOptions(
      { relay: { promptCacheKey: true } },
      "relay",
      "openai-chat-v1",
    );
    expect(enabled).toEqual({
      metadata: { promptCacheKey: true },
      warnings: [],
    });

    stubJson(chatReply);
    await createOpenAiChatAdapter().generateText(
      { baseUrl: RELAY },
      request(enabled.metadata),
      context,
    );
    expect(sentBody().prompt_cache_key).toBe(KEY);
    expect(sentBody()).not.toHaveProperty("promptCacheKey");

    stubJson(responsesReply);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: OPENAI },
      request({ promptCacheKey: false }),
      context,
    );
    expect(sentBody()).not.toHaveProperty("prompt_cache_key");
    expect(sentBody()).not.toHaveProperty("promptCacheKey");
  });

  it("keeps a key the target configured itself", async () => {
    stubJson(chatReply);
    await createOpenAiChatAdapter().generateText(
      { baseUrl: OPENAI },
      request({ prompt_cache_key: "fixed" }),
      context,
    );
    expect(sentBody().prompt_cache_key).toBe("fixed");
  });

  it("reports the option as unsupported on a wire without the field", () => {
    const resolved = resolveProviderOptions(
      { claude: { promptCacheKey: true } },
      "claude",
      "anthropic-messages-v1",
    );
    expect(resolved.metadata).toEqual({});
    expect(resolved.warnings).toHaveLength(1);
  });
});
