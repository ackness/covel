import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type { StreamEvent } from "../src/types.js";

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
