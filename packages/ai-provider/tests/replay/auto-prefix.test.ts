/**
 * S2-T3 replay test — "auto-prefix" providers stay untouched.
 *
 * OpenAI, DeepSeek, and Qwen (all three speak `openai-chat-v1`) cache
 * prompt prefixes transparently. They need no client-side changes for
 * prompt caching to work, and S2-T3 must guarantee that the adapter
 * does NOT accidentally emit a `cache_control` field, a structured
 * `system` array, or any other Anthropic-specific shape.
 *
 * This test pins the invariant by diffing the outgoing request body
 * shape with and without `cacheStrategy: 'auto-prefix'`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../../src/adapters/openai-chat.js";
import type { ProviderConfig, TextMessage } from "../../src/types.js";

// ── Fixture helpers ─────────────────────────────────────────────────

function makeChatResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    async text() {
      return JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
    async json() {
      return {
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      };
    },
  } as unknown as Response;
}

function readPostedBody(): Record<string, unknown> {
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const init = calls[0]![1] as RequestInit | undefined;
  expect(init).toBeDefined();
  expect(typeof init!.body).toBe("string");
  return JSON.parse(init!.body as string) as Record<string, unknown>;
}

function recurseForCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(recurseForCacheControl);
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control" || k === "cacheControl") return true;
      if (recurseForCacheControl(v)) return true;
    }
  }
  return false;
}

const OPENAI_BASE: ProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
};

const BASE_MESSAGES: TextMessage[] = [
  { role: "system", content: "You are a narrator." },
  { role: "user", content: "What happens next?" },
];

// ── Tests ───────────────────────────────────────────────────────────

describe("openai-chat adapter — auto-prefix cache strategy is a no-op (S2-T3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("emits the same request body shape whether cacheStrategy is unset or 'auto-prefix'", async () => {
    const adapter = createOpenAiChatAdapter();

    // First call — no cacheStrategy.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChatResponse()));
    await adapter.generateText(
      OPENAI_BASE,
      { model: "gpt-4o-mini", messages: BASE_MESSAGES },
      { profile: {} as never, preset: undefined, mode: "text" },
    );
    const withoutFlag = readPostedBody();
    vi.unstubAllGlobals();
    vi.clearAllMocks();

    // Second call — cacheStrategy: 'auto-prefix'.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChatResponse()));
    await adapter.generateText(
      { ...OPENAI_BASE, cacheStrategy: "auto-prefix" },
      { model: "gpt-4o-mini", messages: BASE_MESSAGES },
      { profile: {} as never, preset: undefined, mode: "text" },
    );
    const withAutoPrefix = readPostedBody();

    expect(withAutoPrefix).toEqual(withoutFlag);
  });

  it("never emits any cache_control field in the request body", async () => {
    const adapter = createOpenAiChatAdapter();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChatResponse()));

    await adapter.generateText(
      { ...OPENAI_BASE, cacheStrategy: "auto-prefix" },
      { model: "gpt-4o-mini", messages: BASE_MESSAGES },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = readPostedBody();
    expect(recurseForCacheControl(body)).toBe(false);
  });

  it("leaves the `messages` array untouched — no transformation, no extra keys", async () => {
    const adapter = createOpenAiChatAdapter();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChatResponse()));

    await adapter.generateText(
      { ...OPENAI_BASE, cacheStrategy: "auto-prefix" },
      { model: "gpt-4o-mini", messages: BASE_MESSAGES },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = readPostedBody();
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs).toEqual([
      { role: "system", content: "You are a narrator." },
      { role: "user", content: "What happens next?" },
    ]);
  });

  it("passes through a 'none' cacheStrategy identically", async () => {
    const adapter = createOpenAiChatAdapter();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChatResponse()));

    await adapter.generateText(
      { ...OPENAI_BASE, cacheStrategy: "none" },
      { model: "gpt-4o-mini", messages: BASE_MESSAGES },
      { profile: {} as never, preset: undefined, mode: "text" },
    );

    const body = readPostedBody();
    expect(recurseForCacheControl(body)).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a narrator." },
      { role: "user", content: "What happens next?" },
    ]);
  });
});
