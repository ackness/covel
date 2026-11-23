import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { ProviderSourceResolver } from "../src/provider-source.js";
import {
  AiProviderError,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
} from "../src/index.js";

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const payload =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("provider-source gateway and OpenAI Responses request shaping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies requestShape (instructions lift, late system to user, omit, force, transform) and aggregates forced-stream SSE for generateText and generateObject", async () => {
    const adapter = createOpenAiResponsesAdapter();
    const observedRequests: Array<Record<string, unknown>> = [];
    const wireBodies: Array<Record<string, unknown>> = [];

    const sseTextEvents = [
      {
        type: "response.created",
        response: { id: "resp_sse_1", model: "sub-model" },
      },
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "world!" },
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Thinking step. ",
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"q":"cov',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: 'el"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"q":"covel"}',
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_sse_1",
          model: "sub-model",
          status: "completed",
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      },
    ];

    const sseObjectEvents = [
      {
        type: "response.created",
        response: { id: "resp_obj_1", model: "sub-model" },
      },
      { type: "response.output_text.delta", delta: '{"answer":' },
      { type: "response.output_text.delta", delta: '"shaped"}' },
      {
        type: "response.completed",
        response: {
          id: "resp_obj_1",
          model: "sub-model",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ];

    let callIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        wireBodies.push(parsed);
        const events = callIndex++ === 0 ? sseTextEvents : sseObjectEvents;
        return Promise.resolve(sseResponse(events));
      }),
    );

    const requestShape = {
      omit: ["temperature", "max_output_tokens"],
      force: { store: false, stream: true },
      systemAs: "instructions" as const,
      transform: (body: Record<string, unknown>) => ({
        ...body,
        metadataTag: "sub-gateway",
      }),
    };

    const textResult = await adapter.generateText(
      {
        baseUrl: "http://127.0.0.1:18765/backend-api",
        headers: { authorization: "Bearer sub-token-1" },
        requestShape,
        requestObservation: {
          provider: "fake-plugin/sub",
          protocol: "openai-responses-v1",
          onRequest: (req) =>
            observedRequests.push(req as unknown as Record<string, unknown>),
        },
      },
      {
        model: "sub-model",
        providerRequestMetadata: {
          parameterOverrides: { temperature: 0.7, maxOutputTokens: 256 },
        },
        messages: [
          { role: "system", content: "Lead system instruction." },
          { role: "user", content: "First user turn." },
          { role: "system", content: "Late reminder." },
        ],
      },
    );

    expect(textResult.text).toBe("Hello world!");
    expect(textResult.reasoningContent).toBe("Thinking step. ");
    expect(textResult.toolCalls).toEqual([
      { id: "call_1", name: "lookup", arguments: '{"q":"covel"}' },
    ]);
    expect(textResult.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cachedInputTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(textResult.finishReason).toBe("stop");

    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]?.body).toMatchObject({
      stream: true,
      instructions: "Lead system instruction.",
    });
    expect(
      (observedRequests[0]?.body as Record<string, unknown> | undefined)
        ?.temperature,
    ).toBeUndefined();
    expect(wireBodies[0]).toMatchObject({
      store: false,
      stream: true,
      instructions: "Lead system instruction.",
      metadataTag: "sub-gateway",
    });
    expect(wireBodies[0]?.temperature).toBeUndefined();
    expect(wireBodies[0]?.max_output_tokens).toBeUndefined();
    const inputItems = wireBodies[0]?.input as Array<{
      role: string;
      content: string;
    }>;
    expect(inputItems.map((m) => m.role)).toEqual(["user", "user"]);
    expect(inputItems[1]?.content).toBe(
      "<system-instruction>\nLate reminder.\n</system-instruction>",
    );

    const objResult = await adapter.generateObject(
      {
        baseUrl: "http://127.0.0.1:18765/backend-api",
        headers: { authorization: "Bearer sub-token-1" },
        requestShape,
      },
      {
        model: "sub-model",
        schema: z.object({ answer: z.string() }),
        providerRequestMetadata: {
          parameterOverrides: { temperature: 0.4 },
        },
        messages: [{ role: "user", content: "Return JSON" }],
      },
    );

    expect(objResult.object).toEqual({ answer: "shaped" });
    expect(objResult.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(objResult.finishReason).toBe("stop");
    expect(wireBodies[1]?.stream).toBe(true);
    expect(wireBodies[1]?.store).toBe(false);
    expect(wireBodies[1]?.temperature).toBeUndefined();
  });

  it("projects non-sensitive credentialSource in resolveSlot, enforces origin-lock, retries 401 once pre-delta, fails over across accounts, and rejects embed on text-only source", async () => {
    const adapterCalls: Array<{
      mode: string;
      model: string;
      auth: string | undefined;
      relayable: unknown;
      account: string | undefined;
    }> = [];

    const mockAdapter: ModelProviderAdapter = {
      async generateText(config, params) {
        const auth = config.headers?.authorization;
        adapterCalls.push({
          mode: "text",
          model: params.model,
          auth,
          relayable: config.relayable,
          account: config.credentialSource?.accountId,
        });
        if (config.credentialSource?.accountId === "acct-quota") {
          throw new AiProviderError({
            code: "RATE_LIMITED",
            provider: "fake-plugin/sub",
            model: params.model,
            statusCode: 429,
            message: "quota exceeded",
            retriable: false,
          });
        }
        if (auth === "Bearer expired-token") {
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            provider: "fake-plugin/sub",
            model: params.model,
            statusCode: 401,
            message: "token expired",
            retriable: false,
          });
        }
        return {
          text: `ok:${config.credentialSource?.accountId}:${auth}`,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async generateObject(config, params) {
        return {
          object: params.schema.parse({ ok: true }),
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async *streamText(config, params) {
        const auth = config.headers?.authorization;
        adapterCalls.push({
          mode: "stream",
          model: params.model,
          auth,
          relayable: config.relayable,
          account: config.credentialSource?.accountId,
        });
        if (params.model === "post-delta-401") {
          yield { type: "text-delta", textDelta: "partial " };
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            provider: "fake-plugin/sub",
            model: params.model,
            statusCode: 401,
            message: "mid-stream unauthorized",
            retriable: false,
          });
        }
        if (auth === "Bearer expired-token") {
          throw new AiProviderError({
            code: "PROVIDER_ERROR",
            provider: "fake-plugin/sub",
            model: params.model,
            statusCode: 401,
            message: "stream expired",
            retriable: false,
          });
        }
        yield { type: "text-delta", textDelta: `stream:${auth}` };
        yield {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      },
      async embed() {
        return {
          embeddings: [[0.1]],
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    };

    let currentToken = "expired-token";
    let generation = 1;
    let returnMismatchedOrigin = false;
    const refreshCalls: Array<{
      accountId?: string;
      failedGeneration?: number;
    }> = [];

    const resolver: ProviderSourceResolver = {
      inspectSync(sourceId, accountId) {
        return {
          sourceId,
          ...(accountId ? { accountId } : {}),
          ready: true,
          baseUrl: "https://sub.example.test/backend",
          protocol: "openai-responses-v1",
          modes: ["text"],
        };
      },
      async resolve(req) {
        if (returnMismatchedOrigin) {
          return {
            sourceId: req.sourceId,
            declaredBaseUrl: "https://sub.example.test/backend",
            declaredProtocol: "openai-responses-v1",
            accountId: req.accountId ?? "acct-main",
            baseUrl: "https://evil.example.net/backend",
            protocol: "openai-responses-v1",
            headers: { authorization: `Bearer ${currentToken}` },
            credentialGeneration: generation,
          };
        }
        return {
          sourceId: req.sourceId,
          declaredBaseUrl: "https://sub.example.test/backend",
          declaredProtocol: "openai-responses-v1",
          accountId: req.accountId ?? "acct-main",
          baseUrl: "https://sub.example.test/backend",
          protocol: "openai-responses-v1",
          headers: { authorization: `Bearer ${currentToken}` },
          credentialGeneration: generation,
        };
      },
      async refresh(req) {
        refreshCalls.push({
          accountId: req.accountId,
          failedGeneration: req.failedGeneration,
        });
        currentToken = "fresh-token";
        generation += 1;
        return {
          sourceId: req.sourceId,
          declaredBaseUrl: "https://sub.example.test/backend",
          declaredProtocol: "openai-responses-v1",
          accountId: req.accountId ?? "acct-main",
          baseUrl: "https://sub.example.test/backend",
          protocol: "openai-responses-v1",
          headers: { authorization: `Bearer ${currentToken}` },
          credentialGeneration: generation,
        };
      },
    };

    const providerRegistry = createProviderRegistry({
      providers: {
        "custom-sub": { adapter: mockAdapter },
      },
    });
    const presetRegistry = createPresetRegistry({
      profiles: [],
      presets: [
        {
          id: "primary",
          name: "Primary",
          tier: "large",
          provider: "custom-sub",
          source: "fake-plugin/sub",
          account: "acct-main",
          model: "sub-1",
          supportedModes: ["text"],
          enabled: true,
          isDefault: true,
        },
        {
          id: "quota-acc",
          name: "Quota Account",
          tier: "large",
          provider: "custom-sub",
          source: "fake-plugin/sub",
          account: "acct-quota",
          model: "sub-1",
          supportedModes: ["text"],
          enabled: true,
          fallbackPresetIds: ["healthy-acc"],
        },
        {
          id: "healthy-acc",
          name: "Healthy Account",
          tier: "large",
          provider: "custom-sub",
          source: "fake-plugin/sub",
          account: "acct-healthy",
          model: "sub-1",
          supportedModes: ["text"],
          enabled: true,
        },
        {
          id: "post-delta",
          name: "Post Delta",
          tier: "large",
          provider: "custom-sub",
          source: "fake-plugin/sub",
          account: "acct-main",
          model: "post-delta-401",
          supportedModes: ["text"],
          enabled: true,
        },
      ],
    });
    const slotRegistry = createSlotRegistry();
    slotRegistry.configure({
      slots: {
        story: { slotId: "story", presetId: "primary", tag: "text" },
      },
    });

    const gateway = createGateway({
      providerRegistry,
      presetRegistry,
      slotRegistry,
      getProviderSources: () => resolver,
    });

    // 1. resolveSlot hides headers/apiKey & relayable
    const resolved = gateway.resolveSlot("story");
    expect(resolved?.credentialSource).toEqual({
      sourceId: "fake-plugin/sub",
      accountId: "acct-main",
      ready: true,
    });
    expect(resolved?.apiKey).toBeUndefined();
    expect(resolved?.headers).toBeUndefined();

    // 2. 401 refresh + single retry in generateText
    const textOut = await gateway.generateText({
      presetId: "story",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(textOut.text).toBe("ok:acct-main:Bearer fresh-token");
    expect(refreshCalls).toEqual([
      { accountId: "acct-main", failedGeneration: 1 },
    ]);
    expect(adapterCalls.every((c) => c.relayable === undefined)).toBe(true);

    // 3. 401 refresh + retry pre-delta in streamText
    currentToken = "expired-token";
    const streamed: string[] = [];
    for await (const event of gateway.streamText({
      presetId: "story",
      messages: [{ role: "user", content: "stream" }],
    })) {
      if (event.type === "text-delta") streamed.push(event.textDelta);
    }
    expect(streamed.join("")).toBe("stream:Bearer fresh-token");
    expect(refreshCalls).toHaveLength(2);

    // 4. Mid-stream 401 after first delta MUST NOT refresh or retry
    await expect(async () => {
      for await (const _ of gateway.streamText({
        presetId: "post-delta",
        messages: [{ role: "user", content: "stream" }],
      })) {
        // drain
      }
    }).rejects.toMatchObject({ statusCode: 401 });
    expect(refreshCalls).toHaveLength(2);

    // 5. Multi-account failover (acct-quota 429 -> acct-healthy succeeds on same sourceId)
    const fallbackOut = await gateway.generateText({
      presetId: "quota-acc",
      messages: [{ role: "user", content: "failover" }],
    });
    expect(fallbackOut.text).toBe("ok:acct-healthy:Bearer fresh-token");

    // 6. Origin-lock enforcement
    returnMismatchedOrigin = true;
    await expect(
      gateway.generateText({
        presetId: "story",
        messages: [{ role: "user", content: "bad origin" }],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    returnMismatchedOrigin = false;

    // 7. Embed on text-only source fails fast before adapter invocation
    await expect(
      gateway.embed({ presetId: "story", values: ["embed me"] }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("uses requestShape.endpointPath verbatim without /v1 injection and rejects invalid endpointPath", async () => {
    const adapter = createOpenAiResponsesAdapter();
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        fetchedUrls.push(url);
        return Promise.resolve(
          sseResponse([
            {
              type: "response.created",
              response: { id: "resp_ep_1", model: "codex-model" },
            },
            { type: "response.output_text.delta", delta: "ok" },
            {
              type: "response.completed",
              response: {
                id: "resp_ep_1",
                model: "codex-model",
                status: "completed",
                usage: { input_tokens: 2, output_tokens: 1 },
              },
            },
          ]),
        );
      }),
    );

    const out = await adapter.generateText(
      {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        headers: { authorization: "Bearer sub-token" },
        requestShape: {
          endpointPath: "/responses",
          force: { store: false, stream: true },
          systemAs: "instructions",
        },
      },
      {
        model: "codex-model",
        messages: [{ role: "user", content: "hi" }],
      },
    );
    expect(out.text).toBe("ok");
    expect(fetchedUrls).toEqual([
      "https://chatgpt.com/backend-api/codex/responses",
    ]);

    for (const badPath of [
      "responses",
      "//evil.test/responses",
      "/../secret",
      "/responses?x=1",
    ]) {
      await expect(
        adapter.generateText(
          {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            headers: { authorization: "Bearer sub-token" },
            requestShape: {
              endpointPath: badPath,
              force: { store: false, stream: true },
            },
          },
          {
            model: "codex-model",
            messages: [{ role: "user", content: "hi" }],
          },
        ),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR", retriable: false });
    }
  });
});
