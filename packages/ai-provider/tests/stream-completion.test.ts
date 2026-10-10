import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type { StreamEvent, TextMessage } from "../src/types.js";

const protocols = [
  {
    name: "chat",
    adapter: createOpenAiChatAdapter,
    text: { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
    terminal: { choices: [{ delta: {}, finish_reason: "stop" }] },
    error: { error: { message: "overloaded" } },
  },
  {
    name: "responses",
    adapter: createOpenAiResponsesAdapter,
    text: { type: "response.output_text.delta", delta: "partial" },
    terminal: { type: "response.completed", response: { status: "completed" } },
    error: { type: "response.failed", response: { status: "failed" } },
  },
  {
    name: "anthropic",
    adapter: createAnthropicMessagesAdapter,
    text: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "partial" },
    },
    terminal: { type: "message_stop" },
    error: { type: "error", error: { type: "overloaded_error" } },
  },
];

function stub(events: unknown[], done = false) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("") + (done ? "data: [DONE]\n\n" : ""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)(
  "$name stream completion",
  ({ adapter, text, terminal, error }) => {
    async function collect(output: StreamEvent[]) {
      for await (const event of adapter().streamText(
        { baseUrl: "https://provider.example", apiKey: "test" },
        { model: "test", messages: [{ role: "user", content: "hi" }] },
      ))
        output.push(event);
    }

    it.each([false, true])(
      "rejects EOF without protocol terminal even with DONE=%s",
      async (done) => {
        stub([text], done);
        const output: StreamEvent[] = [];
        await expect(collect(output)).rejects.toMatchObject({
          code: "PROVIDER_ERROR",
        });
        expect(output.some((event) => event.type === "done")).toBe(false);
      },
    );

    it.each([false, true])(
      "rejects provider error after partial output=%s",
      async (partial) => {
        stub(partial ? [text, error] : [error]);
        const output: StreamEvent[] = [];
        await expect(collect(output)).rejects.toMatchObject({
          code: "PROVIDER_ERROR",
        });
        expect(output.some((event) => event.type === "done")).toBe(false);
      },
    );

    it("accepts a protocol terminal without a transport DONE sentinel", async () => {
      stub([text, terminal]);
      const output: StreamEvent[] = [];
      await collect(output);
      expect(output.at(-1)).toMatchObject({
        type: "done",
        finishReason: "stop",
      });
    });
  },
);

it("does not release chat tool arguments from a truncated generation", async () => {
  stub([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call",
                function: { name: "write", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
  ]);
  const output: StreamEvent[] = [];
  const run = async () => {
    for await (const event of createOpenAiChatAdapter().streamText(
      { baseUrl: "https://provider.example" },
      { model: "test", messages: [] },
    ))
      output.push(event);
  };
  await expect(run()).rejects.toThrow("terminal event");
  // Argument activity is reported; the call itself is never released.
  expect(output).toEqual([{ type: "tool-argument-delta" }]);
});

it("gives streamed tool calls without an id one that no other step of the loop has", async () => {
  stub([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "write", arguments: "{}" } },
              { index: 1, function: { name: "write", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const ids = async (messages: TextMessage[]) => {
    const found: string[] = [];
    for await (const event of createOpenAiChatAdapter().streamText(
      { baseUrl: "https://provider.example" },
      { model: "test", messages },
    ))
      if (event.type === "tool-call") found.push(event.id);
    return found;
  };
  const first: TextMessage[] = [{ role: "user", content: "Write twice." }];
  const stepOne = await ids(first);
  // The next step of the loop sends the first step's calls and results.
  const stepTwo = await ids([
    ...first,
    {
      role: "assistant",
      content: "",
      toolCalls: stepOne.map((id) => ({ id, name: "write", arguments: "{}" })),
    },
    ...stepOne.map((id): TextMessage => ({
      role: "tool",
      toolCallId: id,
      content: "ok",
    })),
  ]);
  const all = [...stepOne, ...stepTwo];
  expect(all).toHaveLength(4);
  expect(new Set(all).size).toBe(4);
  for (const id of all) expect(id).toMatch(/^call_[0-9a-f]{24}$/);
  // The same request names its calls the same way: a replay repeats.
  expect(await ids(first)).toEqual(stepOne);
});

it("keeps a tool call of a reply that is not streamed when it has no id", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () =>
      Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { function: { name: "write", arguments: "{}" } },
                { id: "given", function: { name: "write", arguments: "{}" } },
                { id: "", function: { name: "write", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ),
  );
  const calls = async () =>
    (
      await createOpenAiChatAdapter().generateText(
        { baseUrl: "https://provider.example" },
        { model: "test", messages: [{ role: "user", content: "Write." }] },
      )
    ).toolCalls?.map((call) => call.id);
  const ids = await calls();
  expect(ids).toHaveLength(3);
  expect(ids![1]).toBe("given");
  expect(ids![0]).toMatch(/^call_[0-9a-f]{24}$/);
  expect(ids![2]).toMatch(/^call_[0-9a-f]{24}$/);
  expect(ids![0]).not.toBe(ids![2]);
  expect(await calls()).toEqual(ids);
});
