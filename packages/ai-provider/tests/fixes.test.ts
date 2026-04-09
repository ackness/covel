/**
 * TDD tests for HIGH/MEDIUM issues:
 *
 * HIGH-1: Anthropic adapter must send x-api-key + anthropic-version instead of Bearer
 * HIGH-2: providerRequestMetadata must not allow overriding model/messages/stream/max_tokens/response_format
 * HIGH-3: fetchLiteLlmModels must have a 30s timeout
 * MEDIUM: shouldFallback must NOT trigger on SCHEMA_VALIDATION_FAILED
 * MEDIUM: slotNames dead code removed from llm-loader.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { fetchLiteLlmModels } from "../src/capability/model-db.js";
import { parseLlmConfig } from "../src/config/llm-loader.js";
import { createGateway } from "../src/gateway.js";
import { createPresetRegistry } from "../src/preset-registry.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";

// ── HIGH-1: Anthropic auth headers ───────────────────────────────────

describe("HIGH-1: Anthropic adapter uses x-api-key header", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends x-api-key + anthropic-version instead of Authorization: Bearer for generateText", async () => {
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
      })
    );

    const adapter = createAnthropicMessagesAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key-123" },
      {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
      },
      { profile: {} as never, preset: undefined, mode: "text" }
    );

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const requestInit = fetchCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;

    expect(headers["x-api-key"]).toBe("test-key-123");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("sends x-api-key + anthropic-version for streamText", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n' +
                  'data: {"type":"message_stop"}\n\n'
              )
            );
            controller.close();
          },
        }),
      })
    );

    const adapter = createAnthropicMessagesAdapter();
    const gen = adapter.streamText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "stream-key" },
      {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
      },
      { profile: {} as never, preset: undefined, mode: "stream" }
    );
    for await (const _ of gen) {
      // drain
    }

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const requestInit = fetchCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;

    expect(headers["x-api-key"]).toBe("stream-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("sends x-api-key + anthropic-version for generateObject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: '{"result":true}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      })
    );

    const adapter = createAnthropicMessagesAdapter();
    await adapter.generateObject(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "obj-key" },
      {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        schema: z.object({ result: z.boolean() }),
      },
      { profile: {} as never, preset: undefined, mode: "object" }
    );

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const requestInit = fetchCall[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;

    expect(headers["x-api-key"]).toBe("obj-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });
});

// ── HIGH-2: providerRequestMetadata dangerous key stripping ──────────

describe("HIGH-2: providerRequestMetadata cannot override critical fields", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockOpenAiSuccessResponse() {
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
      })
    );
  }

  function mockAnthropicSuccessResponse() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      })
    );
  }

  it("openai-chat generateText: metadata cannot override model", async () => {
    mockOpenAiSuccessResponse();

    const adapter = createOpenAiChatAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: { model: "attacker-model" },
      },
      { profile: {} as never, preset: undefined, mode: "text" }
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-4o");
  });

  it("openai-chat generateText: metadata cannot override messages", async () => {
    mockOpenAiSuccessResponse();

    const adapter = createOpenAiChatAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "real message", toolCalls: undefined }],
        providerRequestMetadata: {
          messages: [{ role: "user", content: "injected" }],
        },
      },
      { profile: {} as never, preset: undefined, mode: "text" }
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    const msgs = body["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]["content"]).toBe("real message");
  });

  it("openai-chat streamText: metadata cannot override stream flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
                  "data: [DONE]\n\n"
              )
            );
            controller.close();
          },
        }),
      })
    );

    const adapter = createOpenAiChatAdapter();
    const gen = adapter.streamText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: { stream: false },
      },
      { profile: {} as never, preset: undefined, mode: "stream" }
    );
    for await (const _ of gen) {
      // drain
    }

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
  });

  it("openai-chat generateObject: metadata cannot override response_format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: { content: '{"ok":true}', role: "assistant" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 10 },
          }),
      })
    );

    const adapter = createOpenAiChatAdapter();
    await adapter.generateObject(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        schema: z.object({ ok: z.boolean() }),
        providerRequestMetadata: { response_format: { type: "text" } },
      },
      { profile: {} as never, preset: undefined, mode: "object" }
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    const rf = body["response_format"] as Record<string, unknown>;
    expect(rf["type"]).toBe("json_object");
  });

  it("anthropic generateText: metadata cannot override model or max_tokens", async () => {
    mockAnthropicSuccessResponse();

    const adapter = createAnthropicMessagesAdapter();
    await adapter.generateText(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" },
      {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi", toolCalls: undefined }],
        providerRequestMetadata: { model: "attacker-model", max_tokens: 99999 },
      },
      { profile: {} as never, preset: undefined, mode: "text" }
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    expect(body["model"]).toBe("claude-3-haiku-20240307");
    expect(body["max_tokens"]).toBe(1024);
  });

  it("anthropic generateObject: metadata cannot override messages or stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: '{"ok":true}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
      })
    );

    const adapter = createAnthropicMessagesAdapter();
    await adapter.generateObject(
      { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key" },
      {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "real", toolCalls: undefined }],
        schema: z.object({ ok: z.boolean() }),
        providerRequestMetadata: {
          messages: [{ role: "user", content: "injected" }],
          stream: true,
        },
      },
      { profile: {} as never, preset: undefined, mode: "object" }
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>;
    const msgs = body["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]["content"]).toBe("real");
    // stream should not be present in generateObject request
    expect(body["stream"]).toBeUndefined();
  });
});

// ── HIGH-3: fetchLiteLlmModels timeout ───────────────────────────────

describe("HIGH-3: fetchLiteLlmModels has 30s AbortController timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("passes an AbortSignal to the fetch call", async () => {
    let capturedSignal: AbortSignal | null | undefined = null;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            "gpt-4o": {
              max_input_tokens: 128000,
              max_output_tokens: 4096,
              mode: "chat",
            },
          }),
        });
      })
    );

    await fetchLiteLlmModels("https://example.com/models.json");

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal).not.toBeUndefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it("signal aborts after 30 seconds", async () => {
    vi.useFakeTimers();

    let capturedSignal: AbortSignal | null | undefined = null;
    let resolveHangingFetch!: () => void;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
        capturedSignal = init?.signal;
        // Return a controllable promise so we can resolve it after checking abort
        return new Promise<never>((_resolve, reject) => {
          resolveHangingFetch = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })
    );

    const promise = fetchLiteLlmModels("https://example.com/models.json");

    // Wait a tick for the fetch to be called and signal to be captured
    await Promise.resolve();

    // Before timeout, signal should NOT be aborted
    expect(capturedSignal?.aborted).toBe(false);

    // Advance just past the 30s timeout — this fires the setTimeout callback
    vi.advanceTimersByTime(30_001);

    // Signal should now be aborted
    expect(capturedSignal?.aborted).toBe(true);

    // Simulate the fetch rejecting (as browsers do when aborted)
    resolveHangingFetch();

    // Avoid unhandled rejection warnings
    await promise.catch(() => {});
  });
});

// ── MEDIUM: shouldFallback does NOT trigger on SCHEMA_VALIDATION_FAILED ──

describe("MEDIUM: SCHEMA_VALIDATION_FAILED does not trigger fallback", () => {
  it("does not fall back to backup preset on SCHEMA_VALIDATION_FAILED", async () => {
    let callCount = 0;

    const stubAdapter: ModelProviderAdapter = {
      async generateText() {
        callCount++;
        throw new Error(
          JSON.stringify({
            name: "AiProviderError",
            code: "SCHEMA_VALIDATION_FAILED",
            provider: "test",
            retriable: false,
          })
        );
      },
      async generateObject() {
        callCount++;
        throw new Error(
          JSON.stringify({
            name: "AiProviderError",
            code: "SCHEMA_VALIDATION_FAILED",
            provider: "test",
            retriable: false,
          })
        );
      },
      async *streamText() {
        yield {
          type: "done" as const,
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async embed() {
        return { embeddings: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async generateImage() {
        return { images: [], usage: null };
      },
      async synthesizeSpeech() {
        return {
          audio: { mimeType: "audio/mp3", data: new Uint8Array() },
          usage: null,
        };
      },
      async transcribeAudio() {
        return { text: "", usage: null };
      },
    };

    const profiles: ModelProfile[] = [
      {
        id: "medium",
        tier: "medium",
        provider: "test",
        model: "test-model",
        contextWindow: 64000,
        latencyClass: "medium",
        costClass: "low",
        supportedModes: ["text", "object", "stream"],
      },
    ];

    const presets: PresetConfig[] = [
      {
        id: "primary",
        name: "Primary",
        provider: "test",
        model: "test-model",
        tier: "medium",
        supportedModes: ["text", "object", "stream"],
        enabled: true,
        isDefault: true,
        fallbackPresetIds: ["backup"],
      },
      {
        id: "backup",
        name: "Backup",
        provider: "test",
        model: "backup-model",
        tier: "medium",
        supportedModes: ["text", "object", "stream"],
        enabled: true,
      },
    ];

    const providerRegistry = createProviderRegistry({
      providers: {
        test: {
          adapter: stubAdapter,
          defaults: { baseUrl: "https://test.api" },
        },
      },
    });

    const presetRegistry = createPresetRegistry({ profiles, presets });
    const gateway = createGateway({ providerRegistry, presetRegistry });

    await expect(
      gateway.generateText({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow();

    // SCHEMA_VALIDATION_FAILED should NOT trigger fallback — only 1 attempt
    expect(callCount).toBe(1);
  });
});

// ── MEDIUM: slotNames dead code is removed ────────────────────────────

describe("MEDIUM: slotNames dead code removed from llm-loader.ts", () => {
  it("parseLlmConfig works correctly without the unused slotNames variable", () => {
    const toml = `
[covel.default]
provider = "openai"
model = "gpt-4o"
baseUrl = "https://api.openai.com/v1"
protocol = "openai-chat-v1"

[covel.fast]
provider = "openai"
model = "gpt-4o-mini"
baseUrl = "https://api.openai.com/v1"
protocol = "openai-chat-v1"
`;

    const result = parseLlmConfig(toml);
    expect(result.aiConfig.presets).toHaveLength(2);
    expect(result.aiConfig.presets[0].defaultSlot).toBe("default");
    expect(result.aiConfig.presets[1].defaultSlot).toBe("fast");
    // First slot is the default
    expect(result.aiConfig.presets[0].isDefault).toBe(true);
    expect(result.aiConfig.presets[1].isDefault).toBe(false);
  });
});
