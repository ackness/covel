import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import type { TextMessage } from "../src/types.js";

const config = { baseUrl: "https://provider.example" };
const messages: TextMessage[] = [
  { role: "user", content: "Generate a result" },
];
const protocols = [
  { name: "chat", create: createOpenAiChatAdapter },
  { name: "responses", create: createOpenAiResponsesAdapter },
  { name: "anthropic", create: createAnthropicMessagesAdapter },
];

function mockResponse(value: unknown) {
  const text = JSON.stringify(value);
  const fetcher = vi.fn(async () =>
    Response.json({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function postedBody(index = 0): Record<string, unknown> {
  return JSON.parse(vi.mocked(fetch).mock.calls[index]![1]!.body as string);
}

function requestedSchema(body: Record<string, unknown>, protocol: string) {
  if (protocol === "responses") {
    return (body.text as { format: { schema: Record<string, unknown> } }).format
      .schema;
  }
  const system =
    protocol === "anthropic"
      ? (body.system as string)
      : (body.messages as TextMessage[])
          .filter((message) => message.role === "system")
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  ?.map((part) => (part.type === "text" ? part.text : ""))
                  .join(""),
          )
          .join("\n");
  const match = /<response-format>(.*?)<\/response-format>/s.exec(system);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe.each(protocols)("$name structured output", ({ name, create }) => {
  it("sends each object schema to the provider and retains local validation", async () => {
    mockResponse({});
    const schemas = [
      z.object({ first: z.string().optional() }),
      z.object({ second: z.number().optional() }),
    ];
    for (const schema of schemas) {
      await create().generateObject(config, {
        model: "synthetic",
        messages,
        schema,
      });
    }
    expect(requestedSchema(postedBody(0), name)).toEqual(
      z.toJSONSchema(schemas[0]!, { io: "input" }),
    );
    expect(requestedSchema(postedBody(1), name)).toEqual(
      z.toJSONSchema(schemas[1]!, { io: "input" }),
    );
    expect(postedBody(0)).not.toEqual(postedBody(1));
    if (name === "responses") {
      expect(postedBody().text).toMatchObject({
        format: { type: "json_schema", name: "structured_output" },
      });
    } else if (name === "chat") {
      expect(postedBody().response_format).toEqual({ type: "json_object" });
    }
    await expect(
      create().generateObject(config, {
        model: "synthetic",
        messages,
        schema: z.object({ required: z.string() }),
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("describes transform inputs and still applies transforms and defaults", async () => {
    mockResponse({ amount: "42" });
    const result = await create().generateObject(config, {
      model: "synthetic",
      messages,
      schema: z.object({
        amount: z.string().transform(Number),
        enabled: z.boolean().default(true),
      }),
    });
    expect(result.object).toEqual({ amount: 42, enabled: true });
    expect(requestedSchema(postedBody(), name)).toMatchObject({
      properties: {
        amount: { type: "string" },
        enabled: { type: "boolean", default: true },
      },
      required: ["amount"],
    });
  });

  it("keeps refinements enforced by safeParse", async () => {
    mockResponse({ count: 3 });
    await expect(
      create().generateObject(config, {
        model: "synthetic",
        messages,
        schema: z.object({
          count: z.number().refine((value) => value % 2 === 0),
        }),
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("rejects unrepresentable input schemas before making a request", async () => {
    const fetcher = mockResponse({});
    await expect(
      create().generateObject(config, {
        model: "synthetic",
        messages,
        schema: z.object({ timestamp: z.date() }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves responseFormat with streaming=%s",
    async (streaming) => {
      const schema = {
        title: "Result schema",
        type: "object",
        properties: { ok: { type: "boolean" } },
      };
      const params = {
        model: "synthetic",
        messages,
        responseFormat: { type: "json_schema" as const, schema },
      };
      if (streaming) {
        const terminal =
          name === "chat"
            ? { choices: [{ delta: {}, finish_reason: "stop" }] }
            : name === "responses"
              ? {
                  type: "response.completed",
                  response: { status: "completed", output: [] },
                }
              : { type: "message_stop" };
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              }),
          ),
        );
        for await (const _event of create().streamText(config, params)) {
          /* Consume the request. */
        }
      } else {
        mockResponse({ ok: true });
        await create().generateText(config, params);
      }
      const body = postedBody();
      expect(requestedSchema(body, name)).toEqual(schema);
      if (name === "chat")
        expect(body.response_format).toEqual({ type: "json_object" });
      if (name === "responses")
        expect(body.text).toEqual({
          format: { type: "json_schema", name: "Result_schema", schema },
        });
    },
  );

  it("does not duplicate an existing runtime schema instruction", async () => {
    mockResponse({});
    const schema = { type: "object", properties: {} };
    const marker = `<response-format>${JSON.stringify(schema)}</response-format>`;
    await create().generateText(config, {
      model: "synthetic",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: `Return JSON. ${marker}` }],
        },
        ...messages,
      ],
      responseFormat: { type: "json_schema", schema },
    });
    const body = postedBody();
    const content = JSON.stringify(
      name === "responses"
        ? body.input
        : name === "chat"
          ? body.messages
          : body.system,
    );
    expect(content.match(/<response-format>/g)).toHaveLength(1);
  });
});
