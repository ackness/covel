import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { TextMessage } from "../src/types.js";

const config = { baseUrl: "https://fixture.invalid" };
const messages: TextMessage[] = [{ role: "user", content: "fixture" }];
function respond(body: Record<string, unknown>) {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(body));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function stream(events: Record<string, unknown>[]) {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

const anthropicContent = [
  {
    type: "thinking",
    thinking: "Visible summary",
    signature: "opaque-signature",
  },
  { type: "redacted_thinking", data: "opaque-redacted" },
  { type: "text", text: '{"ok":true}' },
];
const responsesOutput = [
  {
    type: "reasoning",
    id: "reason-1",
    summary: [{ type: "summary_text", text: "Visible summary" }],
    encrypted_content: "opaque-encrypted",
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: '{"ok":true}' }],
  },
];
const cases: Array<{
  name: string;
  adapter: () => ModelProviderAdapter;
  model: string;
  response: Record<string, unknown>;
}> = [
  {
    name: "Chat",
    adapter: createOpenAiChatAdapter,
    model: "qwen3.8-flash",
    response: {
      choices: [
        {
          message: {
            content: '{"ok":true}',
            reasoning_content: "Visible summary",
          },
        },
      ],
    },
  },
  {
    name: "Anthropic",
    adapter: createAnthropicMessagesAdapter,
    model: "claude-sonnet-4-6",
    response: { content: anthropicContent },
  },
  {
    name: "Responses",
    adapter: createOpenAiResponsesAdapter,
    model: "gpt-5.2",
    response: { output: responsesOutput },
  },
];

describe("normalized provider reasoning", () => {
  it.each(cases)(
    "$name keeps text and object reasoning separate from the answer",
    async ({ adapter, model, response }) => {
      respond(response);
      const text = await adapter().generateText(config, { model, messages });
      expect(text.reasoningContent).toBe("Visible summary");
      expect(text.text).toBe('{"ok":true}');
      const object = await adapter().generateObject(config, {
        model,
        messages,
        schema: z.object({ ok: z.boolean() }),
      });
      expect(object.reasoningContent).toBe("Visible summary");
      expect(object.object).toEqual({ ok: true });
    },
  );

  it("accumulates Anthropic thinking and preserves signed block order across a tool follow-up", async () => {
    stream([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Visible " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "summary" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "opaque-signature" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque-redacted" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"key":"value"}' },
      },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    const adapter = createAnthropicMessagesAdapter();
    const events = await Array.fromAsync(
      adapter.streamText(config, { model: "claude-sonnet-4-6", messages }),
    );
    const done = events.find((event) => event.type === "done")!;
    expect(done.reasoningContent).toBe("Visible summary");
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", reasoningDelta: "Visible " },
      { type: "reasoning-delta", reasoningDelta: "summary" },
    ]);
    const fetcher = respond({ content: [{ type: "text", text: "done" }] });
    await adapter.generateText(config, {
      model: "claude-sonnet-4-6",
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tool-1", name: "lookup", arguments: '{"key":"value"}' },
          ],
          providerContinuation: done.providerContinuation,
        },
        { role: "tool", toolCallId: "tool-1", content: "result" },
      ],
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body));
    expect(body.messages[1].content).toEqual([
      ...anthropicContent.slice(0, 2),
      {
        type: "tool_use",
        id: "tool-1",
        name: "lookup",
        input: { key: "value" },
      },
    ]);
  });

  it("reconciles Responses delta/done/terminal summaries without duplicates and replays encrypted state", async () => {
    const output = [
      ...responsesOutput,
      {
        type: "function_call",
        call_id: "tool-1",
        name: "lookup",
        arguments: "{}",
      },
    ];
    const fetcher = stream([
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reason-1",
        output_index: 0,
        summary_index: 0,
        delta: "partial",
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: "reason-1",
        output_index: 0,
        summary_index: 0,
        text: "Visible summary",
      },
      { type: "response.completed", response: { status: "completed", output } },
    ]);
    const adapter = createOpenAiResponsesAdapter();
    const events = await Array.fromAsync(
      adapter.streamText(config, {
        model: "gpt-5.2",
        messages,
        providerRequestMetadata: {
          store: false,
          include: ["message.output_text.logprobs"],
        },
      }),
    );
    const done = events.find((event) => event.type === "done")!;
    expect(done.reasoningContent).toBe("Visible summary");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1].body))).toMatchObject({
      reasoning: { summary: "auto" },
      include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
    });
    const next = respond({ output: [] });
    const params = {
      model: "gpt-5.2",
      messages: [
        {
          role: "assistant",
          content: '{"ok":true}',
          providerContinuation: done.providerContinuation,
        },
        { role: "tool", toolCallId: "tool-1", content: "result" },
      ],
    };
    await adapter.generateText(config, params);
    expect(JSON.parse(String(next.mock.calls[0]![1].body)).input).toEqual([
      ...output,
      { type: "function_call_output", call_id: "tool-1", output: "result" },
    ]);
    await adapter.generateText({ baseUrl: "https://other.invalid" }, params);
    expect(
      JSON.stringify(JSON.parse(String(next.mock.calls[1]![1].body)).input),
    ).not.toContain("opaque-encrypted");
  });

  it("ignores opaque-only reasoning for display", async () => {
    respond({
      content: [
        { type: "thinking", thinking: "", signature: "opaque" },
        { type: "redacted_thinking", data: "opaque" },
      ],
    });
    const result = await createAnthropicMessagesAdapter().generateText(config, {
      model: "claude-sonnet-4-6",
      messages,
    });
    expect(result.reasoningContent).toBeUndefined();
    expect(result.providerContinuation?.items).toHaveLength(2);
  });
});

describe("Anthropic thinking parameter compatibility", () => {
  it("enables adaptive thinking and strips incompatible inherited sampling", async () => {
    const fetcher = respond({ content: [] });
    await createAnthropicMessagesAdapter().generateText(config, {
      model: "claude-sonnet-4-6",
      messages,
      providerRequestMetadata: {
        temperature: 0.6,
        top_k: 10,
        top_p: 0.8,
        parameterOverrides: { reasoningEffort: "high", temperature: 0.7 },
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body));
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    for (const key of ["temperature", "top_k", "top_p"])
      expect(body).not.toHaveProperty(key);
  });

  it("clears incompatible inherited effort when explicitly disabling thinking", async () => {
    const fetcher = respond({ content: [] });
    await createAnthropicMessagesAdapter().generateText(config, {
      model: "claude-opus-5",
      messages,
      providerRequestMetadata: {
        output_config: { effort: "max" },
        thinking: { type: "adaptive", display: "summarized" },
        parameterOverrides: { reasoningEffort: "disabled" },
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1].body));
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("output_config.effort");
  });
});
