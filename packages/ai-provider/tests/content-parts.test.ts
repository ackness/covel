import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type {
  ModelRequestContext,
  PresetConfig,
  TextMessage,
} from "../src/types.js";

const IMAGE_REF = {
  id: "a".repeat(64),
  mime: "image/png",
  size: 1234,
  url: "https://cdn.example.test/image.png",
};

const IMAGE_REF_WITHOUT_URL = {
  id: "b".repeat(64),
  mime: "image/png",
  size: 456,
};

const MULTIMODAL_MESSAGE: TextMessage = {
  role: "user",
  content: [
    { type: "text", text: "Inspect this image." },
    { type: "image", image: IMAGE_REF },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    }),
  );
}

function readRequestBody(): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init).toBeDefined();
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("content part serialization", () => {
  it("serializes image parts for OpenAI Chat", async () => {
    stubFetch({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      { model: "gpt-4.1-mini", messages: [MULTIMODAL_MESSAGE] },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: IMAGE_REF.url } },
        ],
      },
    ]);
  });

  it("serializes image parts for OpenAI Responses", async () => {
    stubFetch({
      output_text: "ok",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      { model: "gpt-4.1-mini", messages: [MULTIMODAL_MESSAGE] },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    expect(readRequestBody().input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image." },
          { type: "input_image", image_url: IMAGE_REF.url },
        ],
      },
    ]);
  });

  it("serializes image parts for Anthropic Messages", async () => {
    stubFetch({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test" },
      { model: "claude-3-5-sonnet-latest", messages: [MULTIMODAL_MESSAGE] },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image", source: { type: "url", url: IMAGE_REF.url } },
        ],
      },
    ]);
  });

  it("downgrades image parts to text descriptors for text-only models (capability fallback)", async () => {
    stubFetch({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const textOnlyPreset = {
      capability: { input: ["text"], output: ["text"] },
    } as unknown as PresetConfig;
    const context: ModelRequestContext = {
      profile: {} as never,
      preset: textOnlyPreset,
      mode: "text",
    };

    await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.deepseek.com/v1", apiKey: "test" },
      { model: "deepseek-chat", messages: [MULTIMODAL_MESSAGE] },
      context,
    );

    const body = readRequestBody();
    const messages = body.messages as Array<{
      content: Array<{ type: string; text: string }>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[0]!.content[0]).toEqual({
      type: "text",
      text: "Inspect this image.",
    });
    // Image part is collapsed into a text descriptor — same image_ref shape
    // adapters use when a URL is missing, so the model still sees the asset id.
    const downgradedText = messages[0]!.content[1]!.text;
    expect(messages[0]!.content[1]!.type).toBe("text");
    expect(JSON.parse(downgradedText)).toMatchObject({
      type: "image_ref",
      ref: IMAGE_REF,
    });
  });

  it("keeps image parts intact for vision-capable models", async () => {
    stubFetch({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const visionPreset = {
      capability: { input: ["text", "image"], output: ["text"] },
    } as unknown as PresetConfig;
    const context: ModelRequestContext = {
      profile: {} as never,
      preset: visionPreset,
      mode: "text",
    };

    await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      { model: "gpt-4.1-mini", messages: [MULTIMODAL_MESSAGE] },
      context,
    );

    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: IMAGE_REF.url } },
        ],
      },
    ]);
  });

  it("keeps string messages unchanged and uses text references for unresolved MediaRef images", async () => {
    stubFetch({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      {
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You inspect assets." },
          {
            role: "user",
            content: [{ type: "image", image: IMAGE_REF_WITHOUT_URL }],
          },
        ],
      },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = readRequestBody();
    expect(body.messages).toMatchObject([
      { role: "system", content: "You inspect assets." },
      { role: "user", content: [{ type: "text" }] },
    ]);
    const unresolvedText = (
      body.messages as Array<{ content: Array<{ text: string }> }>
    )[1]?.content[0]?.text;
    expect(JSON.parse(unresolvedText)).toMatchObject({
      type: "image_ref",
      ref: IMAGE_REF_WITHOUT_URL,
    });
  });
});
