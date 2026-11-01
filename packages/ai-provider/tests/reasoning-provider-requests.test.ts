import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type {
  ModelRequestContext,
  TextGenerationParams,
} from "../src/types.js";

const CONNECTIONS = [
  { provider: "openai", baseUrl: "https://api.openai.com/v1" },
  { provider: "relay", baseUrl: "https://relay.example/v1" },
  { provider: "default", baseUrl: "https://custom.example/v1" },
  { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { provider: "vercel", baseUrl: "https://ai-gateway.vercel.sh/v1" },
];

const TOOL = {
  type: "function" as const,
  function: { name: "note", parameters: { type: "object" } },
};

afterEach(() => vi.unstubAllGlobals());

async function request(
  connection: (typeof CONNECTIONS)[number],
  params: Partial<TextGenerationParams> = {},
  mode: "text" | "stream" = "text",
  protocol: "openai-chat-v1" | "openai-responses-v1" = "openai-chat-v1",
): Promise<Record<string, unknown>> {
  const generation: TextGenerationParams = {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "Take a note." }],
    tools: [TOOL],
    ...params,
  };
  const context: ModelRequestContext = {
    profile: {
      id: "test",
      tier: "medium",
      provider: connection.provider,
      model: generation.model,
      contextWindow: 8192,
      latencyClass: "medium",
      costClass: "medium",
      supportedModes: ["text", "stream"],
    },
    preset: null,
    mode,
  };
  const chat = {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  };
  const response = {
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  };
  const transport = vi.fn(async () =>
    mode === "stream"
      ? new Response(`data: ${JSON.stringify(chat)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(protocol === "openai-chat-v1" ? chat : response),
  );
  vi.stubGlobal("fetch", transport);
  const adapter =
    protocol === "openai-chat-v1"
      ? createOpenAiChatAdapter()
      : createOpenAiResponsesAdapter();
  if (mode === "stream") {
    for await (const _event of adapter.streamText(
      connection,
      generation,
      context,
    )) {
      // Consume the stream so the mocked transport sees the request.
    }
  } else {
    await adapter.generateText(connection, generation, context);
  }
  expect(transport).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledWith(
    `${connection.baseUrl}/${protocol === "openai-chat-v1" ? "chat/completions" : "responses"}`,
    expect.any(Object),
  );
  const init = vi.mocked(fetch).mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe.each(CONNECTIONS)(
  "reasoning requests through $provider",
  (connection) => {
    it.each(["text", "stream"] as const)(
      "%s sends none for GPT-6 Chat tools regardless of the chosen effort",
      async (mode) => {
        for (const reasoningEffort of [undefined, "high", "provider-default"]) {
          const body = await request(
            connection,
            {
              providerRequestMetadata: {
                parameterOverrides: { reasoningEffort },
              },
            },
            mode,
          );
          expect(body.model).toBe("gpt-6-luna");
          expect(body.tools).toHaveLength(1);
          expect(body.reasoning_effort).toBe("none");
        }
      },
    );

    it("resolves the same rule for a namespaced model ID", async () => {
      const body = await request(connection, { model: "openai/gpt-6-luna" });
      expect(body.model).toBe("openai/gpt-6-luna");
      expect(body.reasoning_effort).toBe("none");
    });

    it("preserves the selected effort without tools", async () => {
      const body = await request(connection, {
        tools: [],
        providerRequestMetadata: { reasoningEffort: "high" },
      });
      expect(body.reasoning_effort).toBe("high");
      expect(await request(connection, { tools: [] })).not.toHaveProperty(
        "reasoning_effort",
      );
    });

    it("keeps reasoning with tools on Responses", async () => {
      const body = await request(
        connection,
        { providerRequestMetadata: { reasoningEffort: "high" } },
        "text",
        "openai-responses-v1",
      );
      expect(body.tools).toHaveLength(1);
      expect(body.reasoning).toMatchObject({ effort: "high" });
      expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("keeps a non-OpenAI model's thinking switch with tools", async () => {
      const body = await request(connection, {
        model: "deepseek/deepseek-v4-flash",
        providerRequestMetadata: { reasoningEffort: "high" },
      });
      expect(body.tools).toHaveLength(1);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
    });
  },
);
