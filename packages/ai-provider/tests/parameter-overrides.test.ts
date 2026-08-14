import { afterEach, describe, expect, it, vi } from "vitest";

import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";

describe("provider parameter overrides", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps parameterOverrides onto OpenAI chat request fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: { content: "hi", role: "assistant" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 10 },
          }),
      }),
    );

    const adapter = createOpenAiChatAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: {
          parameterOverrides: {
            temperature: 0.25,
            topP: 0.85,
            maxOutputTokens: 321,
            frequencyPenalty: 0.4,
            presencePenalty: 0.6,
          },
        },
      },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body.temperature).toBe(0.25);
    expect(body.top_p).toBe(0.85);
    expect(body.max_tokens).toBe(321);
    expect(body.frequency_penalty).toBe(0.4);
    expect(body.presence_penalty).toBe(0.6);
  });

  it("maps parameterOverrides onto OpenAI responses request fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "completed",
            output: [{ type: "output_text", text: "hi" }],
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      }),
    );

    const adapter = createOpenAiResponsesAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: {
          parameterOverrides: {
            temperature: 0.1,
            topP: 0.9,
            maxOutputTokens: 654,
          },
        },
      },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body.temperature).toBe(0.1);
    expect(body.top_p).toBe(0.9);
    expect(body.max_output_tokens).toBe(654);
  });

  it("maps parameterOverrides onto Anthropic request fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      }),
    );

    const adapter = createAnthropicMessagesAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "anthropic-key" },
      {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: {
          parameterOverrides: {
            temperature: 0.45,
            topP: 0.7,
            maxOutputTokens: 777,
          },
        },
      },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;

    expect(body.temperature).toBe(0.45);
    expect(body.top_p).toBe(0.7);
    expect(body.max_tokens).toBe(777);
  });

  it("maps a namespaced DeepSeek effort onto its OpenAI-compatible fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: { content: "hi", role: "assistant" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 10 },
          }),
      }),
    );

    await createOpenAiChatAdapter().generateText(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
      {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        providerRequestMetadata: {
          parameterOverrides: { reasoningEffort: "max" },
        },
      },
      {
        profile: { provider: "openai" } as never,
        preset: {
          provider: "openai",
          model: "deepseek/deepseek-v4-flash",
        } as never,
        mode: "text",
      },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  it("maps OpenAI Responses effort into reasoning.effort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "completed",
            output: [{ type: "output_text", text: "hi" }],
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      }),
    );

    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        providerRequestMetadata: {
          parameterOverrides: { reasoningEffort: "high" },
        },
      },
      {
        profile: { provider: "openai" } as never,
        preset: { provider: "openai", model: "gpt-5.6-sol" } as never,
        mode: "text",
      },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("maps Anthropic effort into output_config.effort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      }),
    );

    await createAnthropicMessagesAdapter().generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "anthropic-key" },
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        providerRequestMetadata: {
          parameterOverrides: { reasoningEffort: "max" },
        },
      },
      {
        profile: { provider: "anthropic" } as never,
        preset: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        } as never,
        mode: "text",
      },
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
