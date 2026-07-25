/**
 * Regression tests for tool calling on the Anthropic Messages adapter.
 *
 * The adapter never serialized `params.tools`, and `toAnthropicMessages`
 * dropped every tool-role message with a one-time warning. Any agent runtime
 * routed to an `anthropic-messages-v1` slot therefore never saw its tools,
 * never emitted a tool call, and produced no proposals — it degraded to
 * narration only, with no error anywhere. `max_tokens` was also pinned at
 * 1024 regardless of the model's advertised budget, truncating long output.
 *
 * These lock in:
 *   1. The request body advertises `tools` in Anthropic's `input_schema` shape.
 *   2. Non-streaming responses surface `tool_use` blocks as `toolCalls`.
 *   3. Streamed tool calls accumulate across `input_json_delta` fragments.
 *   4. Tool-loop messages round-trip as `tool_use` / `tool_result` blocks.
 *   5. `max_tokens` follows the resolved model's capability.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type {
  ModelRequestContext,
  ProviderConfig,
  StreamEvent,
  TextMessage,
  ToolDefinition,
} from "../src/types.js";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function ssePayload(events: Array<Record<string, unknown>>): ReadableStream {
  const encoder = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function stubStream(events: Array<Record<string, unknown>>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      captured.push({ url, body: raw.length > 0 ? JSON.parse(raw) : {} });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: ssePayload(events),
      } as unknown as Response);
    }),
  );
  return captured;
}

function stubJson(payload: Record<string, unknown>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      captured.push({ url, body: raw.length > 0 ? JSON.parse(raw) : {} });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as unknown as Response);
    }),
  );
  return captured;
}

async function collect(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const CONFIG: ProviderConfig = {
  apiKey: "sk-test",
  baseUrl: "https://api.anthropic.com/v1",
} as ProviderConfig;

const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anthropic-messages tool calling", () => {
  it("advertises tools using Anthropic's input_schema shape", async () => {
    const captured = stubJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
    const adapter = createAnthropicMessagesAdapter();

    await adapter.generateText(CONFIG, {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "weather in Tokyo?" }],
      tools: [WEATHER_TOOL],
    });

    expect(captured[0]!.body.tools).toEqual([
      {
        name: "get_weather",
        description: "Look up the weather",
        input_schema: WEATHER_TOOL.function.parameters,
      },
    ]);
  });

  it("surfaces tool_use blocks as toolCalls on a non-streaming response", async () => {
    stubJson({
      content: [
        { type: "text", text: "checking" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "Tokyo" },
        },
      ],
      stop_reason: "tool_use",
    });
    const adapter = createAnthropicMessagesAdapter();

    const result = await adapter.generateText(CONFIG, {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "weather in Tokyo?" }],
      tools: [WEATHER_TOOL],
    });

    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "get_weather", arguments: '{"city":"Tokyo"}' },
    ]);
  });

  it("accumulates a streamed tool call across input_json_delta fragments", async () => {
    stubStream([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_2", name: "get_weather" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"ci' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ty":"Ky' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'oto"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    const adapter = createAnthropicMessagesAdapter();

    const events = await collect(
      adapter.streamText(CONFIG, {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "weather?" }],
        tools: [WEATHER_TOOL],
      }),
    );

    // Emitted once, whole — a partial argument string is not valid JSON.
    expect(events).toContainEqual({
      type: "tool-call",
      id: "toolu_2",
      name: "get_weather",
      arguments: '{"city":"Kyoto"}',
    });
  });

  it("round-trips a tool loop as tool_use / tool_result blocks", async () => {
    const captured = stubJson({
      content: [{ type: "text", text: "It is sunny." }],
      stop_reason: "end_turn",
    });
    const adapter = createAnthropicMessagesAdapter();

    const messages: TextMessage[] = [
      { role: "user", content: "weather in Tokyo?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "toolu_3",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
      { role: "tool", content: "sunny, 22C", toolCallId: "toolu_3" },
    ];

    await adapter.generateText(CONFIG, {
      model: "claude-sonnet-4",
      messages,
      tools: [WEATHER_TOOL],
    });

    const sent = captured[0]!.body.messages as Array<Record<string, unknown>>;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_3",
          name: "get_weather",
          input: { city: "Tokyo" },
        },
      ],
    });
    // Results ride a user turn — Anthropic rejects a bare tool role.
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_3", content: "sunny, 22C" },
      ],
    });
  });

  it("merges parallel tool results into a single user turn", async () => {
    const captured = stubJson({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    });
    const adapter = createAnthropicMessagesAdapter();

    await adapter.generateText(CONFIG, {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "two cities?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "get_weather", arguments: '{"city":"A"}' },
            { id: "t2", name: "get_weather", arguments: '{"city":"B"}' },
          ],
        },
        { role: "tool", content: "rain", toolCallId: "t1" },
        { role: "tool", content: "snow", toolCallId: "t2" },
      ],
      tools: [WEATHER_TOOL],
    });

    const sent = captured[0]!.body.messages as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(3);
    expect(sent[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "rain" },
      { type: "tool_result", tool_use_id: "t2", content: "snow" },
    ]);
  });
});

describe("anthropic-messages max_tokens", () => {
  it("uses the resolved model's advertised output budget", async () => {
    const captured = stubJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
    const adapter = createAnthropicMessagesAdapter();
    const context = {
      preset: { capability: { maxOutputTokens: 8192 } },
    } as unknown as ModelRequestContext;

    await adapter.generateText(
      CONFIG,
      { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      context,
    );

    expect(captured[0]!.body.max_tokens).toBe(8192);
  });

  it("falls back to the floor when the model advertises no budget", async () => {
    const captured = stubJson({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
    const adapter = createAnthropicMessagesAdapter();

    await adapter.generateText(CONFIG, {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(captured[0]!.body.max_tokens).toBe(1024);
  });
});
