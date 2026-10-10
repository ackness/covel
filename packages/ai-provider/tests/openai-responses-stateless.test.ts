import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { TextMessage } from "../src/types.js";

const messages: TextMessage[] = [{ role: "user", content: "fixture" }];
const model = "fixture-reasoner";

function respondEach(responses: Array<() => Response>) {
  let call = 0;
  const fetcher = vi.fn().mockImplementation(async () => {
    const next = responses[Math.min(call++, responses.length - 1)]!;
    return next();
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const completed =
  (output: unknown[] = []) =>
  () =>
    Response.json({ status: "completed", output });
const sentBody = (fetcher: ReturnType<typeof respondEach>, call: number) =>
  JSON.parse(String(fetcher.mock.calls[call]![1].body)) as Record<
    string,
    unknown
  >;

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI Responses without provider-side storage", () => {
  it("sends store: false and asks for encrypted reasoning whatever the model is called", async () => {
    const fetcher = respondEach([completed()]);
    const adapter = createOpenAiResponsesAdapter();
    const config = { baseUrl: "https://default.invalid" };
    await adapter.generateText(config, { model, messages });
    expect(sentBody(fetcher, 0)).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
    });

    await adapter.generateText(config, {
      model,
      messages,
      providerRequestMetadata: { reasoning: { effort: "none" } },
    });
    expect(sentBody(fetcher, 1).store).toBe(false);
    expect(sentBody(fetcher, 1)).not.toHaveProperty("include");
  });

  it("sends function tools as not strict, so optional arguments stay optional", async () => {
    const fetcher = respondEach([completed()]);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://tools.invalid" },
      {
        model,
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {
                type: "object",
                properties: { note: { type: "string" } },
              },
            },
          },
        ],
      },
    );
    expect(sentBody(fetcher, 0).tools).toEqual([
      {
        type: "function",
        name: "lookup",
        parameters: {
          type: "object",
          properties: { note: { type: "string" } },
        },
        strict: false,
      },
    ]);
  });

  it("keeps provider-side storage when the slot asks for it", async () => {
    const fetcher = respondEach([completed()]);
    const adapter = createOpenAiResponsesAdapter();
    const config = { baseUrl: "https://stored.invalid" };
    const stored = [
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
    ];
    await adapter.generateText(config, {
      model,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "",
          providerContinuation: {
            protocol: "openai-responses-v1",
            model,
            baseUrl: config.baseUrl,
            items: stored,
          },
        },
        { role: "tool", toolCallId: "call_1", content: "result" },
      ],
      providerRequestMetadata: { store: true },
    });
    const body = sentBody(fetcher, 0);
    expect(body.store).toBe(true);
    expect(body).not.toHaveProperty("include");
    // The provider finds the reasoning item by its ID.
    expect(body.input).toEqual([
      { role: "user", content: "fixture" },
      ...stored,
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
  });

  it("replays reasoning only with its encrypted content", async () => {
    const fetcher = respondEach([completed()]);
    const adapter = createOpenAiResponsesAdapter();
    const config = { baseUrl: "https://replay.invalid" };
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
    };
    const replay = (reasoning: Record<string, unknown>) =>
      adapter.generateText(config, {
        model,
        messages: [
          {
            role: "assistant",
            content: "",
            providerContinuation: {
              protocol: "openai-responses-v1",
              model,
              baseUrl: config.baseUrl,
              items: [reasoning, call],
            },
          },
          { role: "tool", toolCallId: "call_1", content: "result" },
        ],
      });
    const result = {
      type: "function_call_output",
      call_id: "call_1",
      output: "result",
    };

    const carried = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "opaque",
    };
    await replay(carried);
    expect(sentBody(fetcher, 0).input).toEqual([carried, call, result]);

    // Without the encrypted content the provider would look the ID up and
    // fail: the reasoning item is left out and no ID is sent.
    await replay({ type: "reasoning", id: "rs_1", summary: [] });
    const { id: _id, ...callWithoutId } = call;
    expect(sentBody(fetcher, 1).input).toEqual([callWithoutId, result]);
  });

  it("retries once without encrypted reasoning when the model refuses it, and stops asking", async () => {
    const refusal = () =>
      Response.json(
        {
          error: {
            message: "Encrypted content is not supported with this model.",
            type: "invalid_request_error",
            param: "include",
          },
        },
        { status: 400 },
      );
    const fetcher = respondEach([refusal, completed()]);
    const adapter = createOpenAiResponsesAdapter();
    const config = { baseUrl: "https://refuses.invalid" };
    const params = {
      model,
      messages,
      providerRequestMetadata: { include: ["message.output_text.logprobs"] },
    };
    await adapter.generateText(config, params);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sentBody(fetcher, 1)).toMatchObject({
      store: false,
      include: ["message.output_text.logprobs"],
    });

    await adapter.generateText(config, params);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sentBody(fetcher, 2).include).toEqual([
      "message.output_text.logprobs",
    ]);
  });

  it("does not retry another 400", async () => {
    const fetcher = respondEach([
      () =>
        Response.json(
          { error: { message: "Unknown parameter.", param: "input" } },
          { status: 400 },
        ),
    ]);
    const adapter = createOpenAiResponsesAdapter();
    await expect(
      adapter.generateText(
        { baseUrl: "https://other-400.invalid" },
        { model, messages },
      ),
    ).rejects.toThrow(/Unknown parameter/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops reading a 400 body that does not end", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    let sent = 0;
    const cancelled = vi.fn();
    respondEach([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel: cancelled,
          }),
          { status: 400 },
        ),
    ]);
    const adapter = createOpenAiResponsesAdapter();
    await expect(
      adapter.generateText(
        { baseUrl: "https://endless-400.invalid" },
        { model, messages },
      ),
    ).rejects.toThrow(/byte limit/);
    expect(cancelled).toHaveBeenCalled();
    expect(sent).toBeLessThan(4 * 1024 * 1024);
  });

  it("keeps the streamed items when the final event has an empty output", async () => {
    const items = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "opaque",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
    ];
    const events = [
      ...items.map((item, output_index) => ({
        type: "response.output_item.done",
        output_index,
        item,
      })),
      {
        type: "response.completed",
        response: { status: "completed", output: [] },
      },
    ];
    respondEach([
      () =>
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    const done = (
      await Array.fromAsync(
        createOpenAiResponsesAdapter().streamText(
          { baseUrl: "https://empty-output.invalid" },
          { model, messages },
        ),
      )
    ).find((event) => event.type === "done");
    expect(done?.providerContinuation?.items).toEqual(items);
  });
});
