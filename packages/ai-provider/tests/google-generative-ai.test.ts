import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";
import type { StreamEvent, TextGenerationParams } from "../src/types.js";

// Synthetic fixtures based on https://ai.google.dev/api/generate-content and
// https://github.com/vercel/ai/blob/main/packages/google/src/google-language-model.ts.
// No provider credentials, captured responses, or private content.
const config = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: "synthetic-test-key",
};
const params: TextGenerationParams = {
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello" }],
};
const adapter = createGoogleGenerativeAiAdapter();
const answer = (
  parts: unknown[] = [{ text: "Hello" }],
  finishReason = "STOP",
) => ({
  candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 5,
    cachedContentTokenCount: 4,
  },
});

afterEach(() => vi.unstubAllGlobals());
function mockJson(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}
function request(index = 0) {
  const [url, init] = vi.mocked(fetch).mock.calls[index]!;
  return {
    url: String(url),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)),
    signal: init?.signal,
  };
}
function mockStream(payloads: unknown[], suffix = "") {
  const wire =
    payloads
      .map((payload) => `data: ${JSON.stringify(payload)}\r\n\r\n`)
      .join("") + suffix;
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (offset >= bytes.length) return controller.close();
            // Split JSON, UTF-8 text, and CRLF across transport chunks.
            controller.enqueue(bytes.slice(offset, offset + 7));
            offset += 7;
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  );
  return cancel;
}
async function stream(overrides: Partial<TextGenerationParams> = {}) {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamText(config, {
    ...params,
    ...overrides,
  }))
    events.push(event);
  return events;
}

describe("Gemini native generateContent", () => {
  it("applies explicit text-only capability projection", async () => {
    mockJson(answer());
    await adapter.generateText(
      config,
      {
        ...params,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: "data:image/png;base64,YWJjZA==" },
            ],
          },
        ],
      },
      {
        mode: "text",
        profile: {} as never,
        preset: { capability: { input: ["text"] } } as never,
      },
    );
    expect(request().body.contents[0].parts).toEqual([{ text: "[image]" }]);
  });

  it("preserves unsigned native function IDs across tool rounds", async () => {
    const native = [
      {
        functionCall: {
          id: "native-unsigned",
          name: "lookup",
          args: { key: "a" },
        },
      },
    ];
    mockJson(answer(native));
    const result = await adapter.generateText(config, params);
    await adapter.generateText(config, {
      ...params,
      messages: [
        ...params.messages,
        {
          role: "assistant",
          content: result.text,
          toolCalls: result.toolCalls,
          providerContinuation: result.providerContinuation,
        },
        { role: "tool", toolCallId: "native-unsigned", content: "found" },
      ],
    });
    expect(request(1).body.contents[1]).toEqual({
      role: "model",
      parts: native,
    });
    expect(request(1).body.contents[2].parts[0].functionResponse).toEqual({
      id: "native-unsigned",
      name: "lookup",
      response: { result: "found" },
    });
  });

  it.each([
    {
      candidates: [
        {
          finishReason: "SAFETY",
          finishMessage: 42,
          content: { parts: [{ text: 42 }] },
        },
      ],
    },
    { promptFeedback: { blockReason: "SAFETY" }, candidates: "malformed" },
  ])("prioritizes explicit refusal over malformed content", async (payload) => {
    mockJson(payload);
    await expect(adapter.generateText(config, params)).rejects.toMatchObject({
      code: "REFUSAL",
      retriable: false,
    });
    mockStream([payload]);
    await expect(stream()).rejects.toMatchObject({
      code: "REFUSAL",
      retriable: false,
    });
  });

  it("warns and drops Gemini 2.5 penalties on text/object/stream results", async () => {
    const overrides = {
      providerRequestMetadata: {
        parameterOverrides: { frequencyPenalty: 0.5 },
        generationConfig: { presencePenalty: 0.2 },
      },
    };
    const warnings = [
      { type: "unsupported", feature: "frequencyPenalty" },
      { type: "unsupported", feature: "presencePenalty" },
    ];
    mockJson(answer());
    const result = await adapter.generateText(config, {
      ...params,
      ...overrides,
    });
    expect(request().body.generationConfig).not.toHaveProperty(
      "frequencyPenalty",
    );
    expect(request().body.generationConfig).not.toHaveProperty(
      "presencePenalty",
    );
    expect(result.diagnostics?.warnings).toMatchObject(warnings);
    mockJson(answer([{ text: '{"ok":true}' }]));
    expect(
      (
        await adapter.generateObject(config, {
          ...params,
          ...overrides,
          schema: z.object({ ok: z.boolean() }),
        })
      ).diagnostics?.warnings,
    ).toMatchObject(warnings);
    mockStream([answer()]);
    expect((await stream(overrides)).at(-1)).toMatchObject({
      type: "done",
      diagnostics: { warnings },
    });
  });

  it("uses native endpoint/key, system instruction, usage and canonical parameters", async () => {
    mockJson({ ...answer(), futureField: { ignored: true } });
    const controller = new AbortController();
    const result = await adapter.generateText(
      { ...config, signal: controller.signal },
      {
        ...params,
        model: "gemini-3-flash-preview",
        messages: [
          { role: "system", content: "Be concise" },
          ...params.messages,
        ],
        providerRequestMetadata: {
          parameterOverrides: {
            maxOutputTokens: 80,
            temperature: 0.3,
            topP: 0.8,
            topK: 12,
            frequencyPenalty: 0.2,
            presencePenalty: 0.1,
          },
          cachedContent: "cachedContents/synthetic",
          seed: 9,
        },
      },
    );
    expect(request()).toMatchObject({
      url: `${config.baseUrl}/models/gemini-3-flash-preview:generateContent`,
      body: {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        systemInstruction: { parts: [{ text: "Be concise" }] },
        generationConfig: {
          maxOutputTokens: 80,
          temperature: 0.3,
          topP: 0.8,
          topK: 12,
          frequencyPenalty: 0.2,
          presencePenalty: 0.1,
          seed: 9,
        },
        cachedContent: "cachedContents/synthetic",
      },
      signal: controller.signal,
    });
    expect(request().headers.get("x-goog-api-key")).toBe("synthetic-test-key");
    expect(request().headers.has("authorization")).toBe(false);
    expect(result).toEqual({
      text: "Hello",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 },
    });
  });

  it("sends schema, protects canonical fields, and applies Zod input transforms", async () => {
    mockJson(answer([{ text: '{"kind":"ok","count":"2"}' }]));
    const schema = z.object({
      kind: z.literal("ok"),
      count: z.string().transform(Number),
      label: z.string().default("default"),
    });
    const result = await adapter.generateObject(config, {
      ...params,
      schema,
      providerRequestMetadata: {
        contents: [],
        tools: [{ bad: true }],
        parameterOverrides: { maxOutputTokens: 90 },
        generationConfig: {
          maxOutputTokens: 9000,
          responseMimeType: "text/plain",
          responseJsonSchema: {},
          temperature: 0.4,
        },
      },
    });
    expect(result.object).toEqual({ kind: "ok", count: 2, label: "default" });
    expect(request().body.generationConfig).toMatchObject({
      maxOutputTokens: 90,
      temperature: 0.4,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["ok"] },
          count: { type: "string" },
        },
      },
    });
    expect(request().body.contents).toHaveLength(1);
    expect(request().body.tools).toBeUndefined();
    mockJson(answer([{ text: '{"name":"x"}' }]));
    await adapter.generateObject(config, {
      ...params,
      schema: z.object({ name: z.string() }),
    });
    expect(
      request().body.generationConfig.responseJsonSchema.properties,
    ).toEqual({ name: { type: "string" } });
  });

  it("validates object responses, including custom refinements", async () => {
    mockJson(answer([{ text: '{"count":2}' }]));
    await expect(
      adapter.generateObject(config, {
        ...params,
        schema: z.object({
          count: z.number().refine((value) => value % 2 === 1),
        }),
      }),
    ).rejects.toMatchObject({
      code: "SCHEMA_VALIDATION_FAILED",
      retriable: false,
    });
    mockJson(answer([{ text: "not-json" }]));
    await expect(
      adapter.generateObject(config, {
        ...params,
        schema: z.object({ count: z.number() }),
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("fails unrepresentable schemas before sending a request", async () => {
    mockJson(answer());
    await expect(
      adapter.generateObject(config, {
        ...params,
        schema: z.object({ date: z.date() }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends native inline and Google file images and rejects arbitrary URLs", async () => {
    mockJson(answer());
    const image = (url: string) => ({
      type: "image" as const,
      image: url,
      mediaType: "image/png",
    });
    await adapter.generateText(config, {
      ...params,
      messages: [
        {
          role: "user",
          content: [
            image("data:image/png;base64,YWJjZA=="),
            { type: "image", image: "YWJjZA==", mediaType: "image/jpeg" },
            image(
              "https://generativelanguage.googleapis.com/v1beta/files/synthetic",
            ),
          ],
        },
      ],
    });
    expect(request().body.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "YWJjZA==" } },
      { inlineData: { mimeType: "image/jpeg", data: "YWJjZA==" } },
      {
        fileData: {
          mimeType: "image/png",
          fileUri:
            "https://generativelanguage.googleapis.com/v1beta/files/synthetic",
        },
      },
    ]);
    await expect(
      adapter.generateText(config, {
        ...params,
        messages: [
          { role: "user", content: [image("https://example.test/image.png")] },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves signed parallel calls and maps reversed tool results to native names and order", async () => {
    const native = [
      { text: "Plan", thought: true },
      {
        functionCall: { id: "native-a", name: "alpha", args: { x: 1 } },
        thoughtSignature: "synthetic-signature",
      },
      { functionCall: { name: "beta", args: {} } },
    ];
    mockJson(answer(native));
    const result = await adapter.generateText(config, {
      ...params,
      tools: [
        {
          type: "function",
          function: {
            name: "alpha",
            description: "Alpha",
            parameters: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        },
      ],
      defaults: { toolChoice: "required" },
    });
    expect(result).toMatchObject({
      text: "",
      reasoningContent: "Plan",
      finishReason: "tool_calls",
      providerContinuation: {
        protocol: "google-generative-ai-v1",
        model: params.model,
        baseUrl: config.baseUrl,
        items: native,
      },
    });
    // The call without a native id gets a made-up one.
    expect(result.toolCalls?.map((c) => c.id)).toEqual([
      "native-a",
      expect.stringMatching(/^call_[0-9a-f]{24}$/),
    ]);
    expect(request().body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "alpha",
            description: "Alpha",
            parametersJsonSchema: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        ],
      },
    ]);
    expect(request().body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    const [alpha, beta] = result.toolCalls!;
    await adapter.generateText(config, {
      ...params,
      messages: [
        ...params.messages,
        {
          role: "assistant",
          content: result.text,
          toolCalls: result.toolCalls,
          providerContinuation: result.providerContinuation,
        },
        { role: "tool", toolCallId: beta!.id, content: "beta result" },
        { role: "tool", toolCallId: alpha!.id, content: '{"value":2}' },
      ],
    });
    expect(request(1).body.contents.slice(1)).toEqual([
      { role: "model", parts: native },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "native-a",
              name: "alpha",
              response: { value: 2 },
            },
          },
          {
            functionResponse: {
              name: "beta",
              response: { result: "beta result" },
            },
          },
        ],
      },
    ]);
  });

  it.each([true, false])(
    "rejects reordered or edited same-name calls (native IDs: %s)",
    async (withIds) => {
      const native = [
        {
          functionCall: {
            ...(withIds ? { id: "native-a" } : {}),
            name: "lookup",
            args: { x: 1 },
          },
          thoughtSignature: "synthetic-signature",
        },
        {
          functionCall: {
            ...(withIds ? { id: "native-b" } : {}),
            name: "lookup",
            args: { x: 2 },
          },
        },
      ];
      mockJson(answer(native));
      const result = await adapter.generateText(config, params);
      const calls = result.toolCalls!;
      const variants = [
        [...calls].reverse(),
        calls.map((call, index) =>
          index === 0 ? { ...call, arguments: '{"x":99}' } : call,
        ),
        ...(withIds
          ? [
              calls.map((call, index) => ({
                ...call,
                id: calls[1 - index]!.id,
              })),
            ]
          : []),
      ];
      for (const toolCalls of variants) {
        await expect(
          adapter.generateText(config, {
            ...params,
            messages: [
              {
                role: "assistant",
                content: result.text,
                toolCalls,
                providerContinuation: result.providerContinuation,
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.providerContinuation?.items).toEqual(native);
    },
  );

  it("accepts equivalent JSON property order without changing signed native parts", async () => {
    const native = [
      {
        functionCall: {
          id: "native-a",
          name: "lookup",
          args: { x: 1, nested: { a: true, b: [2, 3] } },
        },
        thoughtSignature: "synthetic-signature",
      },
    ];
    mockJson(answer(native));
    const result = await adapter.generateText(config, params);
    await adapter.generateText(config, {
      ...params,
      messages: [
        {
          role: "assistant",
          content: result.text,
          toolCalls: [
            {
              ...result.toolCalls![0]!,
              arguments: '{"nested":{"b":[2,3],"a":true},"x":1}',
            },
          ],
          providerContinuation: result.providerContinuation,
        },
        { role: "tool", toolCallId: "native-a", content: "found" },
      ],
    });
    expect(request(1).body.contents[0]).toEqual({
      role: "model",
      parts: native,
    });
    expect(request(1).body.contents[1].parts[0].functionResponse.id).toBe(
      "native-a",
    );
    expect(result.providerContinuation?.items).toEqual(native);
  });

  it("rejects wrong-target signed state and preserves text-only trailing signatures", async () => {
    const native = [
      { text: "Answer" },
      { text: "", thoughtSignature: "synthetic-trailing-signature" },
    ];
    mockJson(answer(native));
    const result = await adapter.generateText(config, params);
    expect(result.providerContinuation?.items).toEqual(native);
    const messages = [
      {
        role: "assistant",
        content: result.text,
        providerContinuation: result.providerContinuation,
      },
    ];
    await expect(
      adapter.generateText(config, {
        ...params,
        model: "gemini-3-flash",
        messages,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    await expect(
      adapter.generateText(
        { ...config, baseUrl: "https://other.example.test/v1beta" },
        { ...params, messages },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await adapter.generateText(config, { ...params, messages });
    expect(request(1).body.contents[0].parts).toEqual(native);
  });

  it("rebuilds foreign protocol tool history without leaking opaque state", async () => {
    mockJson(answer());
    await adapter.generateText(config, {
      ...params,
      messages: [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "foreign-call", name: "lookup", arguments: "{}" }],
          providerContinuation: {
            protocol: "anthropic-messages-v1",
            model: "claude",
            baseUrl: "https://example.test",
            items: [
              {
                type: "thinking",
                signature: "foreign-signature",
                thinking: "private",
              },
            ],
          },
        },
        { role: "tool", toolCallId: "foreign-call", content: "ok" },
      ],
    });
    expect(request().body.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { name: "lookup", args: {} } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "lookup", response: { result: "ok" } } },
        ],
      },
    ]);
    expect(JSON.stringify(request().body)).not.toContain("foreign-signature");
  });

  it.each(["SAFETY", "RECITATION", "PROHIBITED_CONTENT"])(
    "classifies %s as a non-retriable refusal",
    async (reason) => {
      mockJson(
        answer(
          [{ text: "Partial" }, { functionCall: { name: "unsafe", args: {} } }],
          reason,
        ),
      );
      await expect(adapter.generateText(config, params)).rejects.toMatchObject({
        code: "REFUSAL",
        retriable: false,
        details: {
          diagnostics: {
            refusal: { reason: "content-filter", message: reason },
          },
        },
      });
    },
  );

  it("classifies blocked prompt without candidates as refusal", async () => {
    mockJson({
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Blocked" },
    });
    await expect(adapter.generateText(config, params)).rejects.toMatchObject({
      code: "REFUSAL",
      retriable: false,
    });
  });

  it.each([
    "MALFORMED_FUNCTION_CALL",
    "UNEXPECTED_TOOL_CALL",
    "MISSING_THOUGHT_SIGNATURE",
  ])("rejects %s instead of successful empty output", async (reason) => {
    mockJson(answer([], reason));
    await expect(adapter.generateText(config, params)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("maps length, citation spans and cache subsets", async () => {
    mockJson({
      candidates: [
        {
          content: { parts: [{ text: "A" }] },
          finishReason: "MAX_TOKENS",
          citationMetadata: {
            citationSources: [
              {
                uri: "https://example.test/source",
                startIndex: 0,
                endIndex: 1,
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 2, cachedContentTokenCount: 7 },
    });
    expect(await adapter.generateText(config, params)).toMatchObject({
      finishReason: "length",
      usage: { inputTokens: 2, outputTokens: 0, cachedInputTokens: 2 },
      diagnostics: {
        sources: [
          {
            type: "url",
            id: "url:https://example.test/source",
            url: "https://example.test/source",
          },
        ],
        citations: [
          {
            sourceId: "url:https://example.test/source",
            location: "response",
            startIndex: 0,
            endIndex: 1,
          },
        ],
      },
    });
  });

  it.each([
    {},
    {
      candidates: [
        { content: { parts: [{ text: 42 }] }, finishReason: "STOP" },
      ],
    },
    {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "bad", args: "{}" } }] },
          finishReason: "STOP",
        },
      ],
    },
    {
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: -1 },
    },
  ])("rejects malformed known wire fields", async (payload) => {
    mockJson(payload);
    await expect(adapter.generateText(config, params)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("preserves explicit native reasoning and lets unified selection replace inherited controls", async () => {
    mockJson(answer());
    await adapter.generateText(config, {
      ...params,
      providerRequestMetadata: {
        thinkingConfig: { thinkingBudget: 100, includeThoughts: true },
      },
    });
    expect(request().body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 100,
      includeThoughts: true,
    });
    await adapter.generateText(config, {
      ...params,
      providerRequestMetadata: {
        reasoningEffort: "provider-default",
        generationConfig: {
          thinkingConfig: { thinkingBudget: 123, includeThoughts: true },
        },
      },
    });
    expect(request(1).body.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
    });
    await adapter.generateText(config, {
      ...params,
      model: "gemini-3-flash-preview",
      providerRequestMetadata: {
        reasoningEffort: "low",
        thinkingConfig: { thinkingBudget: 123, includeThoughts: true },
      },
    });
    expect(request(2).body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });

  it("preserves explicit native tool mode without metadata replacing declarations", async () => {
    mockJson(answer());
    await adapter.generateText(config, {
      ...params,
      tools: [{ type: "function", function: { name: "lookup" } }],
      providerRequestMetadata: {
        tools: [],
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
      },
    });
    expect(request().body.tools).toEqual([
      { functionDeclarations: [{ name: "lookup" }] },
    ]);
    expect(request().body.toolConfig).toEqual({
      functionCallingConfig: { mode: "NONE" },
    });
  });
});

describe("Gemini native SSE", () => {
  it("streams UTF-8 reasoning separately, preserves signatures and waits to emit parallel tools", async () => {
    const signed = {
      functionCall: { name: "lookup", args: { city: "上海" } },
      thoughtSignature: "synthetic-sse-signature",
    };
    mockStream([
      {
        candidates: [{ content: { parts: [{ text: "分析", thought: true }] } }],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "查询" },
                signed,
                { functionCall: { name: "weather", args: {} } },
              ],
            },
          },
        ],
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 4,
        },
      },
    ]);
    const events = await stream({
      responseFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(request().url).toBe(
      `${config.baseUrl}/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
    );
    expect(request().body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "reasoning-delta",
      "text-delta",
      // The call part arrived; the calls themselves wait for the finish.
      "tool-argument-delta",
      "tool-call",
      "tool-call",
      "done",
    ]);
    expect(events[0]).toEqual({
      type: "reasoning-delta",
      reasoningDelta: "分析",
    });
    expect(events[3]).toMatchObject({
      name: "lookup",
      arguments: '{"city":"上海"}',
    });
    expect(events[5]).toMatchObject({
      finishReason: "tool_calls",
      reasoningContent: "分析",
      usage: { inputTokens: 8, outputTokens: 6 },
      providerContinuation: {
        items: [
          { text: "分析", thought: true },
          { text: "查询" },
          signed,
          { functionCall: { name: "weather", args: {} } },
        ],
      },
    });
  });

  it("fails truncated SSE without exposing tool calls", async () => {
    mockStream([
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "lookup", args: {} } }],
            },
          },
        ],
      },
    ]);
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of adapter.streamText(config, params))
          events.push(event);
      })(),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(events).toEqual([]);
  });

  it("rejects malformed SSE following a signed call and releases the reader", async () => {
    const cancel = mockStream(
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "lookup", args: {} },
                    thoughtSignature: "synthetic-signature",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ],
      "data: {bad-json}\n\ntrailing",
    );
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of adapter.streamText(config, params))
          events.push(event);
      })(),
    ).rejects.toThrow("malformed SSE");
    expect(events).toEqual([]);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses after partial output without emitting earlier calls", async () => {
    mockStream([
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "Partial" },
                { functionCall: { name: "lookup", args: {} } },
              ],
            },
          },
        ],
      },
      { candidates: [{ finishReason: "SAFETY" }] },
    ]);
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of adapter.streamText(config, params))
          events.push(event);
      })(),
    ).rejects.toMatchObject({ code: "REFUSAL", retriable: false });
    expect(events).toEqual([{ type: "text-delta", textDelta: "Partial" }]);
  });

  it("rejects partial function arguments and length-truncated calls", async () => {
    mockStream([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "lookup",
                    partialArgs: [],
                    willContinue: true,
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ]);
    await expect(stream()).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    mockStream([
      answer([{ functionCall: { name: "lookup", args: {} } }], "MAX_TOKENS"),
    ]);
    await expect(stream()).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
