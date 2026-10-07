import { afterEach, expect, it, vi } from "vitest";
import { PROMPT_CACHE_BREAKPOINT_MARKER as marker } from "@covel/shared";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    "chat",
    createOpenAiChatAdapter,
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  ],
  [
    "responses",
    createOpenAiResponsesAdapter,
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ],
    },
  ],
  [
    "gemini",
    createGoogleGenerativeAiAdapter,
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
    },
  ],
] as const)(
  "%s removes internal cache markers from string and multipart messages",
  async (_name, create, payload) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetch);
    await create().generateText(
      { baseUrl: "https://provider.example", apiKey: "fixture" },
      {
        model: "synthetic",
        messages: [
          { role: "system", content: `stable${marker}\n\ndynamic` },
          {
            role: "user",
            content: [{ type: "text", text: `question${marker}` }],
          },
        ],
      },
    );
    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(String(call[1]?.body));
    expect(JSON.stringify(body)).not.toContain("COVEL_CACHE_BREAK");
    expect(JSON.stringify(body)).toContain("stable");
    expect(JSON.stringify(body)).toContain("question");
  },
);

it.each([
  createOpenAiChatAdapter,
  createOpenAiResponsesAdapter,
  createAnthropicMessagesAdapter,
])(
  "preserves provider error details and marks deterministic errors non-retryable",
  async (create) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: {
                code: "context_length_exceeded",
                type: "invalid_request_error",
                message: "Input exceeds this model's context window",
              },
            }),
          ),
      ),
    );
    await expect(
      create().generateText(
        { baseUrl: "https://provider.example" },
        {
          model: "synthetic",
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).rejects.toMatchObject({
      retriable: false,
      message: expect.stringContaining(
        "Input exceeds this model's context window",
      ),
      details: {
        providerCode: "context_length_exceeded",
        providerType: "invalid_request_error",
      },
    });
  },
);
