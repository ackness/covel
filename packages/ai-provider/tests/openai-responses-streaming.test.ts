/**
 * Regression tests for OpenAI Responses API streaming tool calls.
 *
 * The Responses `streamText` path previously handled only
 * `response.output_text.delta`, silently dropping every streamed function
 * call. An agent runtime routed to an `openai-responses-v1` slot therefore
 * never received its tool calls and its turn behaviour degraded. These tests
 * lock in:
 *   1. Streaming function-call events accumulate and emit `tool-call`.
 *   2. The request body advertises `tools` in the Responses (flattened) shape.
 *   3. Tool-loop messages round-trip into `function_call` /
 *      `function_call_output` input items so multi-turn loops keep working.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { StreamEvent, ToolDefinition } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function ssePayload(events: Array<Record<string, unknown>>): ReadableStream {
  const encoder = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines + "data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Stub fetch with a streaming SSE body and capture the request. */
function stubStream(events: Array<Record<string, unknown>>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : "";
      captured.push({
        url,
        body: raw.length > 0 ? JSON.parse(raw) : {},
      });
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

/** Stub fetch with a plain JSON body and capture the request. */
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

// ── 1. Streaming function-call accumulation ────────────────────────

describe("openai-responses streamText — function calls", () => {
  it("accumulates Responses function-call SSE events and emits a tool-call", async () => {
    stubStream([
      { type: "response.output_text.delta", delta: "Looking that up..." },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        output_index: 0,
        delta: ' "Paris"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        output_index: 0,
        name: "get_weather",
        arguments: '{"city": "Paris"}',
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const events = await collect(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        {
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [WEATHER_TOOL],
        },
        { profile: {} as never, preset: null, mode: "stream" },
      ),
    );

    expect(events).toContainEqual({
      type: "text-delta",
      textDelta: "Looking that up...",
    });

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toEqual([
      {
        type: "tool-call",
        id: "call_abc",
        name: "get_weather",
        arguments: '{"city": "Paris"}',
      },
    ]);

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("emits multiple parallel tool calls in announcement order", async () => {
    stubStream([
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "alpha",
          arguments: "",
        },
      },
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          name: "beta",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_2",
        delta: '{"b":2}',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"a":1}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"a":1}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_2",
        arguments: '{"b":2}',
      },
      { type: "response.completed", response: { status: "completed" } },
    ]);

    const events = await collect(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        {
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "go" }],
          tools: [WEATHER_TOOL],
        },
        { profile: {} as never, preset: null, mode: "stream" },
      ),
    );

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toEqual([
      { type: "tool-call", id: "call_1", name: "alpha", arguments: '{"a":1}' },
      { type: "tool-call", id: "call_2", name: "beta", arguments: '{"b":2}' },
    ]);
  });

  it("falls back to the item id and `{}` args when call_id / arguments are absent", async () => {
    stubStream([
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", name: "noop" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]);

    const events = await collect(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        {
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "go" }],
          tools: [WEATHER_TOOL],
        },
        { profile: {} as never, preset: null, mode: "stream" },
      ),
    );

    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      { type: "tool-call", id: "fc_1", name: "noop", arguments: "{}" },
    ]);
  });
});

// ── 2. Request body advertises tools in Responses shape ────────────

describe("openai-responses streamText — request body", () => {
  it("sends tools flattened to the Responses shape with tool_choice auto", async () => {
    const captured = stubStream([
      { type: "response.completed", response: { status: "completed" } },
    ]);

    await collect(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        {
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: "hi" }],
          tools: [WEATHER_TOOL],
        },
        { profile: {} as never, preset: null, mode: "stream" },
      ),
    );

    expect(captured[0]?.body.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Look up the weather",
        parameters: WEATHER_TOOL.function.parameters,
      },
    ]);
    expect(captured[0]?.body.tool_choice).toBe("auto");
  });

  it("omits tools when none are provided", async () => {
    const captured = stubStream([
      { type: "response.completed", response: { status: "completed" } },
    ]);

    await collect(
      createOpenAiResponsesAdapter().streamText(
        { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
        { model: "gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] },
        { profile: {} as never, preset: null, mode: "stream" },
      ),
    );

    expect(captured[0]?.body.tools).toBeUndefined();
    expect(captured[0]?.body.tool_choice).toBeUndefined();
  });
});

// ── 3. Tool-loop message round-trip ────────────────────────────────

describe("openai-responses — tool-loop input round-trip", () => {
  it("serializes assistant tool calls and tool results into Responses input items", async () => {
    const captured = stubJson({
      output_text: "done",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      {
        model: "gpt-4.1-mini",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_abc",
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            ],
          },
          { role: "tool", content: '{"temp":21}', toolCallId: "call_abc" },
        ],
        tools: [WEATHER_TOOL],
      },
      { profile: {} as never, preset: null, mode: "text" },
    );

    expect(captured[0]?.body.input).toEqual([
      { role: "user", content: "weather?" },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: '{"temp":21}',
      },
    ]);
  });
});
