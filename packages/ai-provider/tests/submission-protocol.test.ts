import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiChatAdapter,
  createOpenAiResponsesAdapter,
  createAnthropicMessagesAdapter,
  type StreamEvent,
} from "../src/index.js";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";

// Complete arguments remain provider transport data until host submission validation.
const protocols = [
  {
    name: "chat",
    create: createOpenAiChatAdapter,
    events: (raw: string, refused: boolean) => [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call",
                  function: { name: "submit-output", arguments: raw },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: refused ? { refusal: "Refused" } : {},
            finish_reason: refused ? "content_filter" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      },
    ],
  },
  {
    name: "responses",
    create: createOpenAiResponsesAdapter,
    events: (raw: string, refused: boolean) => [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item",
          call_id: "call",
          name: "submit-output",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item",
        delta: raw,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "item",
        arguments: raw,
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 3 },
          output: refused
            ? [
                {
                  type: "message",
                  content: [{ type: "refusal", refusal: "Refused" }],
                },
              ]
            : [],
        },
      },
    ],
  },
  {
    name: "anthropic",
    create: createAnthropicMessagesAdapter,
    events: (raw: string, refused: boolean) => [
      {
        type: "message_start",
        message: { usage: { input_tokens: 2, output_tokens: 0 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call",
          name: "submit-output",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: raw },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: refused ? "refusal" : "tool_use" },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ],
  },
  {
    name: "gemini",
    create: createGoogleGenerativeAiAdapter,
    events: (raw: string, refused: boolean) => {
      let args: unknown;
      try {
        args = JSON.parse(raw);
      } catch {
        args = raw;
      }
      return [
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "call", name: "submit-output", args } },
                ],
              },
            },
          ],
        },
        {
          candidates: [{ finishReason: refused ? "SAFETY" : "STOP" }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
        },
      ];
    },
  },
];
afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)(
  "$name submission transport",
  ({ name, create, events }) => {
    function prepare(raw: string, refused = false) {
      const fetcher = vi.fn(
        async () =>
          new Response(
            events(raw, refused)
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      vi.stubGlobal("fetch", fetcher);
      const output: StreamEvent[] = [];
      return {
        output,
        fetcher,
        run: async () => {
          for await (const event of create().streamText(
            { baseUrl: "https://fixture.invalid/v1" },
            { model: "synthetic", messages: [] },
          ))
            output.push(event);
        },
      };
    }
    it.each(['{"ok":true}', '{"ok":"invalid schema value"}'])(
      "delivers whole arguments only after successful terminal: %s",
      async (raw) => {
        const { output, run } = prepare(raw);
        await run();
        expect(output.filter((event) => event.type === "tool-call")).toEqual([
          {
            type: "tool-call",
            id: "call",
            name: "submit-output",
            arguments: raw,
          },
        ]);
        expect(
          output.filter((event) => event.type === "tool-argument-delta"),
        ).toEqual([{ type: "tool-argument-delta" }]);
        expect(output.at(-1)).toMatchObject({
          type: "done",
          usage: { inputTokens: 2, outputTokens: 3 },
        });
        expect(output.some((event) => event.type === "text-delta")).toBe(false);
      },
    );
    it("lets a late refusal suppress the completed call and preserves billed usage", async () => {
      const { output, fetcher, run } = prepare('{"ok":true}', true);
      await expect(run()).rejects.toMatchObject({
        code: "REFUSAL",
        retriable: false,
        details: { usage: { inputTokens: 2, outputTokens: 3 } },
      });
      expect(
        output.every((event) => event.type === "tool-argument-delta"),
      ).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("retains malformed complete JSON for host correction or rejects malformed native object fields", async () => {
      const { output, run } = prepare('{"ok":');
      if (name === "gemini") {
        await expect(run()).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
        expect(output.some((event) => event.type === "tool-call")).toBe(false);
      } else {
        await run();
        expect(
          output.find((event) => event.type === "tool-call"),
        ).toMatchObject({ arguments: '{"ok":' });
      }
    });
  },
);
