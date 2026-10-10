import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { projectRequestBody } from "../src/adapters/http/request-observation.js";
import type {
  ModelRequestContext,
  PresetConfig,
  TextMessage,
} from "../src/types.js";

const IMAGE_URL = "https://cdn.example.test/image.png";
// The first bytes of a PNG file, as base64.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

const MULTIMODAL_MESSAGE: TextMessage = {
  role: "user",
  content: [
    { type: "text", text: "Inspect this image." },
    { type: "image", image: IMAGE_URL },
  ],
};

const INLINE_MESSAGE: TextMessage = {
  role: "user",
  content: [
    { type: "text", text: "Inspect this image." },
    { type: "image", image: PNG_BASE64, mediaType: "image/png" },
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
  const init = vi.mocked(fetch).mock.calls.at(-1)?.[1] as
    RequestInit | undefined;
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
      { profile: {} as never, preset: null, mode: "text" },
    );

    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: IMAGE_URL } },
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
      { profile: {} as never, preset: null, mode: "text" },
    );

    expect(readRequestBody().input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image." },
          { type: "input_image", image_url: IMAGE_URL },
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
      { profile: {} as never, preset: null, mode: "text" },
    );

    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image", source: { type: "url", url: IMAGE_URL } },
        ],
      },
    ]);
  });

  it("removes image parts for text-only models (capability fallback)", async () => {
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
    // The image is removed; whoever built the request said the same in text.
    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Inspect this image." }],
      },
    ]);
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
          { type: "image_url", image_url: { url: IMAGE_URL } },
        ],
      },
    ]);
  });

  it("sends inline image data in each protocol's own shape", async () => {
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
      { model: "gpt-4.1-mini", messages: [INLINE_MESSAGE] },
      { profile: {} as never, preset: null, mode: "text" },
    );
    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
          },
        ],
      },
    ]);

    stubFetch({
      output_text: "ok",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "test" },
      { model: "gpt-4.1-mini", messages: [INLINE_MESSAGE] },
      { profile: {} as never, preset: null, mode: "text" },
    );
    expect(readRequestBody().input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image." },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${PNG_BASE64}`,
          },
        ],
      },
    ]);

    stubFetch({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test" },
      { model: "claude-3-5-sonnet-latest", messages: [INLINE_MESSAGE] },
      { profile: {} as never, preset: null, mode: "text" },
    );
    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: PNG_BASE64,
            },
          },
        ],
      },
    ]);
  });

  it("reads the format of base64 data that names none from its first bytes", async () => {
    stubFetch({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test" },
      {
        model: "claude-3-5-sonnet-latest",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: "/9j/4AAQSkZJRg==" },
              { type: "image", image: "data:image/webp;base64,UklGRg==" },
            ],
          },
        ],
      },
      { profile: {} as never, preset: null, mode: "text" },
    );
    expect(readRequestBody().messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "/9j/4AAQSkZJRg==",
            },
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/webp",
              data: "UklGRg==",
            },
          },
        ],
      },
    ]);
  });
});

describe("recorded request bodies with inline images", () => {
  it("records the size of inline image data instead of the data", () => {
    const data = "A".repeat(8_000);
    const projected = projectRequestBody(
      JSON.stringify({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${data}` },
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data },
              },
              // Short inline data stays as sent.
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
        ],
      }),
    );
    const text = JSON.stringify(projected.body);
    expect(text).not.toContain(data);
    expect(text).toContain(
      "data:image/png;base64,[8000 base64 characters omitted]",
    );
    expect(text).toContain('"data":"[8000 base64 characters omitted]"');
    expect(text).toContain("data:image/png;base64,AAAA");
    expect(projected.complete).toBe(false);
  });
});
