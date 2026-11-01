import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { captureContinuation } from "../src/adapters/provider-continuation.js";
import type {
  ModelRequestContext,
  TextGenerationParams,
  TextMessage,
} from "../src/types.js";

const config = { baseUrl: "https://fixture.invalid" };

function history(reasoningContent?: string): TextMessage[] {
  return [
    { role: "user", content: "Previous turn" },
    { role: "assistant", content: "Previous answer" },
    { role: "user", content: "Continue" },
    {
      role: "assistant",
      content: "",
      reasoningContent: "Check the scene",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "call-1", content: "Scene found" },
    {
      role: "assistant",
      content: "Draft answer",
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    },
    { role: "system", content: "Repair the answer" },
    { role: "system", content: "Keep the scene" },
  ];
}

function transport(stream = false) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    const choice = {
      [stream ? "delta" : "message"]: { content: '{"ok":true}' },
      finish_reason: "stop",
    };
    return stream
      ? new Response(
          `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`,
        )
      : Response.json({ choices: [choice] });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

type Operation = "generateText" | "streamText" | "generateObject";
async function send(
  operation: Operation,
  params: TextGenerationParams,
  context?: ModelRequestContext,
) {
  const adapter = createOpenAiChatAdapter();
  if (operation === "streamText") {
    return Array.fromAsync(adapter.streamText(config, params, context));
  }
  if (operation === "generateObject") {
    return adapter.generateObject(
      config,
      { ...params, schema: z.object({ ok: z.boolean() }) },
      context,
    );
  }
  return adapter.generateText(config, params, context);
}

afterEach(() => vi.unstubAllGlobals());

describe("Chat reasoning pass-back", () => {
  describe.each<Operation>(["generateText", "streamText", "generateObject"])(
    "%s",
    (operation) => {
      it.each([undefined, "", "Draft thought"])(
        "includes reasoning on a text-only continuation with reasoning %j",
        async (reasoningContent) => {
          const fetcher = transport(operation === "streamText");
          await send(operation, {
            // The upstream family controls pass-back even through a relay.
            model: "deepseek/deepseek-flash",
            messages: history(reasoningContent),
          });
          const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
          const assistants = body.messages.filter(
            (message: Record<string, unknown>) => message.role === "assistant",
          );
          expect(assistants).toEqual([
            { role: "assistant", content: "Previous answer" },
            {
              role: "assistant",
              content: "",
              reasoning_content: "Check the scene",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            {
              role: "assistant",
              content: "Draft answer",
              reasoning_content: reasoningContent ?? "",
            },
          ]);
          expect(body.messages.at(-1).role).toBe("system");
          expect(fetcher).toHaveBeenCalledTimes(1);
        },
      );
    },
  );

  it.each(["deepseek", "relay"])(
    "uses the resolved model family with provider %s and late system nudges sent as user messages",
    async (provider) => {
      const fetcher = transport();
      const context: ModelRequestContext = {
        profile: {
          id: "fixture",
          tier: "medium",
          provider,
          model: "deepseek-flash",
          contextWindow: 32_768,
          latencyClass: "medium",
          costClass: "medium",
          supportedModes: ["text", "object"],
        },
        preset: null,
        mode: "text",
      };
      const messages = history();
      // Even a tool-call step with no exposed reasoning needs the field.
      delete messages[3]?.reasoningContent;
      await send(
        "generateText",
        {
          model: "endpoint-model",
          messages,
          providerRequestMetadata: { lateSystemAsUser: true },
        },
        context,
      );
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(body.messages[1]).not.toHaveProperty("reasoning_content");
      expect(body.messages[3]).toHaveProperty("reasoning_content", "");
      expect(body.messages[5]).toHaveProperty("reasoning_content", "");
      expect(body.messages.at(-1).role).toBe("user");
    },
  );

  it("uses the endpoint's reasoning field for empty text-only steps", async () => {
    const fetcher = transport();
    const model = "deepseek-flash";
    const messages = history();
    const toolStep = messages[3];
    expect(toolStep).toBeDefined();
    if (toolStep) {
      toolStep.providerContinuation = captureContinuation(
        "openai-chat-v1",
        model,
        config,
        [{ type: "reasoning", field: "reasoning" }],
      );
    }
    await send("generateText", { model, messages });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.messages[3]).toHaveProperty("reasoning", "Check the scene");
    expect(body.messages[5]).toHaveProperty("reasoning", "");
    expect(body.messages[5]).not.toHaveProperty("reasoning_content");
  });

  it("keeps the OpenAI-family request bytes unchanged", async () => {
    const fetcher = transport();
    await send("generateText", { model: "gpt-5.2", messages: history("") });
    expect(fetcher.mock.calls[0]?.[1]?.body).toMatchInlineSnapshot(
      `"{"model":"gpt-5.2","messages":[{"role":"user","content":"Previous turn"},{"role":"assistant","content":"Previous answer"},{"role":"user","content":"Continue"},{"role":"assistant","content":"","reasoning_content":"Check the scene","tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","content":"Scene found","tool_call_id":"call-1"},{"role":"assistant","content":"Draft answer"},{"role":"system","content":"Repair the answer"},{"role":"system","content":"Keep the scene"}]}"`,
    );
  });
});
