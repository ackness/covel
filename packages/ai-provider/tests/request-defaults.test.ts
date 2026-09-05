import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type { TextGenerationParams } from "../src/types.js";

const config = { baseUrl: "https://provider.example", apiKey: "test-key" };
const params: TextGenerationParams = {
  model: "qwen3.8-flash",
  messages: [{ role: "user", content: "Extract facts." }],
  tools: [
    {
      type: "function",
      function: { name: "submit-facts", parameters: { type: "object" } },
    },
  ],
  defaults: {
    reasoningEffort: "disabled",
    toolChoice: { name: "submit-facts" },
  },
};
const response = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "submit-facts", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  content: [
    { type: "tool_use", id: "call-1", name: "submit-facts", input: {} },
  ],
  output: [
    {
      type: "function_call",
      call_id: "call-1",
      name: "submit-facts",
      arguments: "{}",
    },
  ],
  status: "completed",
  stop_reason: "tool_use",
  usage: {},
};
function captureResponse() {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return () => body;
}
afterEach(() => vi.unstubAllGlobals());

describe("runtime request defaults", () => {
  it.each([
    {
      create: createOpenAiChatAdapter,
      model: "qwen3.8-flash",
      choice: { type: "function", function: { name: "submit-facts" } },
      reasoning: { enable_thinking: false },
    },
    {
      create: createOpenAiResponsesAdapter,
      model: "gpt-5.4",
      choice: { type: "function", name: "submit-facts" },
      reasoning: { reasoning: { effort: "none" } },
    },
    {
      create: createAnthropicMessagesAdapter,
      model: "claude-opus-4-6",
      choice: { type: "tool", name: "submit-facts" },
      reasoning: {},
    },
  ])(
    "translates named tools and disabled reasoning for $model",
    async ({ create, model, choice, reasoning }) => {
      const captured = captureResponse();
      const result = await create().generateText(config, { ...params, model });
      expect(captured()).toMatchObject({ ...reasoning, tool_choice: choice });
      expect(captured()).not.toHaveProperty("defaults");
      expect(result.toolCalls).toEqual([
        { id: "call-1", name: "submit-facts", arguments: "{}" },
      ]);
    },
  );

  it.each([
    { enable_thinking: true },
    { parameterOverrides: { reasoningEffort: "automatic" } },
  ])(
    "preserves explicit Qwen reasoning and uses compatible automatic tools: %j",
    async (providerRequestMetadata) => {
      const captured = captureResponse();
      await createOpenAiChatAdapter().generateText(config, {
        ...params,
        providerRequestMetadata,
      });
      expect(captured()).toMatchObject({
        enable_thinking: true,
        tool_choice: "auto",
      });
    },
  );

  it("keeps existing automatic selection when no runtime default is declared", async () => {
    const captured = captureResponse();
    await createOpenAiChatAdapter().generateText(config, {
      ...params,
      defaults: undefined,
    });
    expect(captured()).toHaveProperty("tool_choice", "auto");
    expect(captured()).not.toHaveProperty("enable_thinking");
  });

  it("applies the same defaults to streamed requests", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    for await (const _event of createOpenAiChatAdapter().streamText(
      config,
      params,
    )) {
      /* drain */
    }
    expect(body).toMatchObject({
      stream: true,
      enable_thinking: false,
      tool_choice: { type: "function", function: { name: "submit-facts" } },
    });
  });
});
