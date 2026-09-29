import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { assertSuccessfulFinishReason } from "../src/adapters/generation-completion.js";
import type { StreamEvent } from "../src/types.js";

type Fixture = {
  success: Record<string, unknown>;
  stream: Record<string, unknown>[];
  refusal: Record<string, unknown>;
  refusalStream: Record<string, unknown>[];
};
const protocols = [
  { name: "chat", create: createOpenAiChatAdapter },
  { name: "responses", create: createOpenAiResponsesAdapter },
  { name: "anthropic", create: createAnthropicMessagesAdapter },
].map((protocol) => ({
  ...protocol,
  fixture: JSON.parse(
    readFileSync(
      new URL(`./protocol-fixtures/${protocol.name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Fixture,
}));
const config = { baseUrl: "https://provider.example" };
const params = {
  model: "synthetic",
  messages: [{ role: "user", content: "Generate JSON with evidence" }],
  schema: z.object({ ok: z.boolean() }),
};

function respond(payload: unknown, status = 200) {
  const fetcher = vi.fn(async () => Response.json(payload, { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

/** Split SSE across bytes, including JSON/tool argument fragments. */
function stream(events: Record<string, unknown>[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 13) {
                controller.enqueue(bytes.slice(offset, offset + 13));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)(
  "$name protocol diagnostics",
  ({ name, create, fixture }) => {
    it("preserves sources, citations and warnings in text/object results", async () => {
      respond(fixture.success);
      const result = await create().generateText(config, params);
      expect(result.text).toBe('{"ok":true}');
      expect(result.toolCalls).toEqual([
        {
          id: "call_fixture",
          name: "lookup",
          arguments: '{"query":"fixture"}',
        },
      ]);
      expect(result.diagnostics?.warnings).toEqual([
        {
          type: "compatibility",
          feature: "sampling",
          message: "Synthetic provider adjusted sampling.",
        },
      ]);
      expect(result.diagnostics?.sources).toContainEqual({
        type: "url",
        id: "url:https://example.org/source",
        url: "https://example.org/source",
        title: "Synthetic reference",
      });
      expect(result.diagnostics?.citations).toContainEqual(
        name === "anthropic"
          ? {
              sourceId: "document:0",
              location: "source",
              citedText: "Synthetic evidence",
              startPage: 1,
              endPage: 2,
            }
          : {
              sourceId: "url:https://example.org/source",
              location: "response",
              startIndex: 0,
              endIndex: 11,
            },
      );
      if (name === "responses")
        expect(result.diagnostics?.sources).toContainEqual({
          type: "document",
          id: "file:file_fixture",
          title: "fixture.txt",
          fileName: "fixture.txt",
        });
      const object = await create().generateObject(config, params);
      expect(object.object).toEqual({ ok: true });
      expect(object.diagnostics).toEqual(result.diagnostics);
    });

    it("matches diagnostics across fragmented streaming and complete responses", async () => {
      respond(fixture.success);
      const expected = await create().generateText(config, params);
      stream(fixture.stream);
      const events: StreamEvent[] = [];
      for await (const event of create().streamText(config, params))
        events.push(event);
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.textDelta)
          .join(""),
      ).toBe(expected.text);
      expect(events.filter((event) => event.type === "tool-call")).toEqual([
        {
          type: "tool-call",
          id: "call_fixture",
          name: "lookup",
          arguments: '{"query":"fixture"}',
        },
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        diagnostics: expected.diagnostics,
      });
    });

    it.each(["generateText", "generateObject"] as const)(
      "%s rejects explicit refusal, including partial content",
      async (method) => {
        const fetcher = respond(fixture.refusal);
        await expect(create()[method](config, params)).rejects.toMatchObject({
          code: "REFUSAL",
          retriable: false,
          details: {
            diagnostics: {
              refusal: { reason: "refusal", message: "I cannot comply." },
            },
          },
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );

    it("retains a streamed refusal and never emits successful completion", async () => {
      stream(fixture.refusalStream);
      const events: StreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of create().streamText(config, params))
            events.push(event);
        })(),
      ).rejects.toMatchObject({
        code: "REFUSAL",
        retriable: false,
        details: {
          diagnostics: {
            refusal: { reason: "refusal", message: "I cannot comply." },
          },
        },
      });
      expect(events.some((event) => event.type === "done")).toBe(false);
    });
  },
);

it("classifies Chat content-filter completion as non-retryable refusal", async () => {
  respond({
    choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
  });
  await expect(
    createOpenAiChatAdapter().generateText(config, params),
  ).rejects.toMatchObject({
    code: "REFUSAL",
    retriable: false,
    details: { diagnostics: { refusal: { reason: "content-filter" } } },
  });
});

it("preserves filter refusal from non-success HTTP responses", async () => {
  respond(
    {
      error: {
        code: "content_filter",
        message: "Synthetic content policy refusal",
      },
    },
    400,
  );
  await expect(
    createOpenAiChatAdapter().generateText(config, params),
  ).rejects.toMatchObject({
    code: "REFUSAL",
    retriable: false,
    details: {
      diagnostics: {
        refusal: {
          reason: "content-filter",
          message: "Synthetic content policy refusal",
        },
      },
    },
  });
});

it("distinguishes content-filter incomplete Responses from token limits", async () => {
  const output = protocols[1]!.fixture.success.output;
  respond({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    output,
  });
  await expect(
    createOpenAiResponsesAdapter().generateText(config, params),
  ).rejects.toMatchObject({ code: "REFUSAL" });
  respond({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output,
  });
  const result = await createOpenAiResponsesAdapter().generateText(
    config,
    params,
  );
  expect(result.finishReason).toBe("length");
  expect(result.diagnostics?.sources).toHaveLength(2);
});

it("does not retry known refusal when a stream then ends without its terminal event", async () => {
  stream([{ choices: [{ delta: { refusal: "Synthetic refusal" } }] }]);
  await expect(
    (async () => {
      for await (const _event of createOpenAiChatAdapter().streamText(
        config,
        params,
      )) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: "REFUSAL", retriable: false });
});

it("retains a known refusal when later SSE parsing fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"refusal":"Synthetic refusal"}}]}\n\ndata: invalid-json\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
  await expect(
    (async () => {
      for await (const _event of createOpenAiChatAdapter().streamText(
        config,
        params,
      )) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: "REFUSAL", retriable: false });
});

it("preserves nested filtering errors in Responses terminal failure events", async () => {
  stream([
    {
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "content_filter", message: "Synthetic refusal" },
      },
    },
  ]);
  await expect(
    (async () => {
      for await (const _event of createOpenAiResponsesAdapter().streamText(
        config,
        params,
      )) {
        /* consume */
      }
    })(),
  ).rejects.toMatchObject({ code: "REFUSAL", retriable: false });
});

it("does not expose Anthropic tools before a later refusal finishes the turn", async () => {
  stream([
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "call_fixture",
        name: "lookup",
        input: {},
      },
    },
    { type: "content_block_stop", index: 1 },
    ...protocols[2]!.fixture.refusalStream,
  ]);
  const events: StreamEvent[] = [];
  await expect(
    (async () => {
      for await (const event of createAnthropicMessagesAdapter().streamText(
        config,
        params,
      ))
        events.push(event);
    })(),
  ).rejects.toMatchObject({ code: "REFUSAL", retriable: false });
  expect(events.some((event) => event.type === "tool-call")).toBe(false);
});

it.each(["refusal", "content_filter"])(
  "gates custom adapter finishReason %s",
  (reason) => {
    expect(() => assertSuccessfulFinishReason(reason, "synthetic")).toThrow(
      expect.objectContaining({
        code: "REFUSAL",
        retriable: false,
      }),
    );
  },
);
