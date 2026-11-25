import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import type { ProviderSourceResolver } from "../src/provider-source.js";
import {
  AiProviderError,
  attachSourceWireErrorContext,
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
      "/./responses",
      "/../secret",
      "/%2e/responses",
      "/.%2E/responses",
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
    expect(fetchedUrls).toHaveLength(1);
  });

  it("expands multi-account presets asynchronously and passes internal wire error context to classifyError", async () => {
    const providerRegistry = createProviderRegistry();
    const presetRegistry = createPresetRegistry({ profiles: [], presets: [] });
    presetRegistry.reconfigure({
      profiles: [],
      presets: [
        {
          id: "pool",
          name: "Account Pool",
          tier: "large",
          provider: "custom-wire-provider",
          source: "plug/src",
          model: "wire-model",
          protocol: "plug/custom-wire",
          supportedModes: ["text"],
          enabled: true,
        },
      ],
    });
    const slotRegistry = createSlotRegistry();
    slotRegistry.configure({
      slots: { story: { slotId: "story", presetId: "pool", tag: "text" } },
    });

    const seenClassificationInputs: Array<{
      readonly statusCode?: number;
      readonly body?: unknown;
      readonly message: string;
    }> = [];
    const triedAccounts: string[] = [];

    const resolver: ProviderSourceResolver = {
      async listReadyAccounts() {
        return ["acct-1", "acct-2"];
      },
      inspectSync() {
        return {
          sourceId: "plug/src",
          ready: true,
          protocol: "plug/custom-wire",
        };
      },
      async resolve(req) {
        return {
          sourceId: req.sourceId,
          accountId: req.accountId,
          declaredBaseUrl: "https://sub.example.test/v1",
          declaredProtocol: "plug/custom-wire",
          baseUrl: "https://sub.example.test/v1",
          protocol: "plug/custom-wire",
          headers: { authorization: `Bearer tok-${req.accountId}` },
          classifyError(err) {
            seenClassificationInputs.push(err);
            if (
              typeof err.body === "object" &&
              err.body !== null &&
              Reflect.get(err.body, "code") === "insufficient_quota"
            ) {
              return { kind: "quota", message: "Friendly quota limit" };
            }
            return null;
          },
        };
      },
    };

    const { registerTextWire } = await import("../src/index.js");
    const unregister = registerTextWire(
      {
        id: "plug/custom-wire",
        async generateText(config) {
          const auth = config.headers?.authorization ?? "";
          triedAccounts.push(auth);
          if (auth === "Bearer tok-acct-1") {
            const wrapped = new Error(
              'Provider wire "plug/custom-wire" failed',
            );
            attachSourceWireErrorContext(wrapped, {
              body: { code: "insufficient_quota" },
              message: "RAW_SECRET_INTERNAL_BODY",
            });
            throw wrapped;
          }
          return {
            text: `served:${auth}`,
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        async *streamText() {},
      },
      { pluginId: "plug", builtin: false },
    );

    try {
      const gateway = createGateway({
        providerRegistry,
        presetRegistry,
        slotRegistry,
        getProviderSources: () => resolver,
      });
      const out = await gateway.generateText({
        presetId: "story",
        messages: [{ role: "user", content: "failover" }],
      });
      expect(out.text).toBe("served:Bearer tok-acct-2");
      expect(triedAccounts).toEqual(["Bearer tok-acct-1", "Bearer tok-acct-2"]);
      expect(seenClassificationInputs).toEqual([
        {
          statusCode: undefined,
          body: { code: "insufficient_quota" },
          message: "RAW_SECRET_INTERNAL_BODY",
        },
      ]);
    } finally {
      unregister();
    }
  });

  it("blocks provider.source@1 credentials from reaching another plugin's media wires while allowing same-plugin and built-in wires", async () => {
    const { registerImageWire } = await import("../src/image/wire-registry.js");
    const { registerSpeechWire, registerTranscriptionWire } = await import(
      "../src/speech/wire-registry.js"
    );
    const { registerMusicWire } = await import("../src/music/wire-registry.js");

    const leakedHeaders: Array<Record<string, string> | undefined> = [];
    const ownHeaders: Array<Record<string, string> | undefined> = [];

    const unregs = [
      registerImageWire(
        {
          id: "evil-plugin/img",
          async generate(config) {
            leakedHeaders.push(config.headers);
            return {
              images: [
                {
                  kind: "bytes" as const,
                  bytes: new Uint8Array([1]),
                  mime: "image/png",
                },
              ],
              usage: null,
              warnings: [],
            };
          },
        },
        { pluginId: "evil-plugin", builtin: false },
      ),
      registerSpeechWire(
        {
          id: "evil-plugin/tts",
          async synthesize(config) {
            leakedHeaders.push(config.headers);
            return {
              audio: { data: new Uint8Array([1]), mimeType: "audio/mpeg" },
              usage: null,
              warnings: [],
            };
          },
        },
        { pluginId: "evil-plugin", builtin: false },
      ),
      registerTranscriptionWire(
        {
          id: "evil-plugin/stt",
          async transcribe(config) {
            leakedHeaders.push(config.headers);
            return { text: "leaked", usage: null, warnings: [] };
          },
        },
        { pluginId: "evil-plugin", builtin: false },
      ),
      registerMusicWire(
        {
          id: "evil-plugin/music",
          async compose(config) {
            leakedHeaders.push(config.headers);
            return {
              audio: { data: new Uint8Array([1]), mimeType: "audio/mpeg" },
              usage: null,
              warnings: [],
            };
          },
        },
        { pluginId: "evil-plugin", builtin: false },
      ),
      registerImageWire(
        {
          id: "owner-plugin/img",
          async generate(config) {
            ownHeaders.push(config.headers);
            return {
              images: [
                {
                  kind: "bytes" as const,
                  bytes: new Uint8Array([1]),
                  mime: "image/png",
                },
              ],
              usage: null,
              warnings: [],
            };
          },
        },
        { pluginId: "owner-plugin", builtin: false },
      ),
      registerMusicWire(
        {
          id: "owner-plugin/music",
          async compose(config) {
            ownHeaders.push(config.headers);
            return {
              audio: { data: new Uint8Array([2]), mimeType: "audio/mpeg" },
              usage: null,
              warnings: [],
            };
          },
        },
        { pluginId: "owner-plugin", builtin: false },
      ),
    ];

    const resolver: ProviderSourceResolver = {
      inspectSync(sourceId) {
        return {
          sourceId,
          ready: true,
          baseUrl: "https://media.example.test/v1",
          protocol: "openai-chat-v1",
          modes: ["image", "speech", "transcription", "music"],
        };
      },
      async resolve(req) {
        return {
          sourceId: req.sourceId,
          approvedInstanceOwner: "owner-plugin",
          declaredBaseUrl: "https://media.example.test/v1",
          declaredProtocol: "openai-chat-v1",
          baseUrl: "https://media.example.test/v1",
          protocol: "openai-chat-v1",
          headers: { authorization: "Bearer owner-oauth-secret" },
          credentialGeneration: 1,
        };
      },
      async refresh() {
        return null;
      },
    };

    const providerRegistry = createProviderRegistry();
    const presetRegistry = createPresetRegistry({
      profiles: [],
      presets: [
        {
          id: "cross-img",
          name: "Cross Img",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "img-1",
          supportedModes: ["image"],
          tag: "image",
          enabled: true,
          providerRequestMetadata: { imageWire: "evil-plugin/img" },
        },
        {
          id: "cross-tts",
          name: "Cross TTS",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "tts-1",
          supportedModes: ["speech"],
          tag: "speech",
          enabled: true,
          providerRequestMetadata: { speechWire: "evil-plugin/tts" },
        },
        {
          id: "cross-stt",
          name: "Cross STT",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "stt-1",
          supportedModes: ["transcription"],
          tag: "transcription",
          enabled: true,
          providerRequestMetadata: { transcriptionWire: "evil-plugin/stt" },
        },
        {
          id: "cross-music",
          name: "Cross Music",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "music-1",
          supportedModes: ["music"],
          tag: "music",
          enabled: true,
          providerRequestMetadata: { musicWire: "evil-plugin/music" },
        },
        {
          id: "own-img",
          name: "Own Img",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "img-1",
          supportedModes: ["image"],
          tag: "image",
          enabled: true,
          providerRequestMetadata: { imageWire: "owner-plugin/img" },
        },
        {
          id: "own-music",
          name: "Own Music",
          tier: "large",
          provider: "sub-media",
          source: "owner-plugin/media",
          model: "music-1",
          supportedModes: ["music"],
          tag: "music",
          enabled: true,
          providerRequestMetadata: { musicWire: "owner-plugin/music" },
        },
      ],
    });
    const slotRegistry = createSlotRegistry();
    const gateway = createGateway({
      providerRegistry,
      presetRegistry,
      slotRegistry,
      getProviderSources: () => resolver,
    });

    try {
      await expect(
        gateway.generateImage({ presetId: "cross-img", prompt: "castle" }),
      ).rejects.toThrow(/cannot receive credentials from provider source plugin "owner-plugin"/);
      await expect(
        gateway.synthesizeSpeech({ presetId: "cross-tts", text: "hello" }),
      ).rejects.toThrow(/cannot receive credentials from provider source plugin "owner-plugin"/);
      await expect(
        gateway.transcribeAudio({
          presetId: "cross-stt",
          audio: { data: new Uint8Array([1]), mimeType: "audio/wav" },
        }),
      ).rejects.toThrow(/cannot receive credentials from provider source plugin "owner-plugin"/);
      await expect(
        gateway.composeMusic({ presetId: "cross-music", prompt: "tavern" }),
      ).rejects.toThrow(/cannot receive credentials from provider source plugin "owner-plugin"/);
      expect(leakedHeaders).toEqual([]);

      await expect(
        gateway.generateImage({ presetId: "own-img", prompt: "castle" }),
      ).resolves.toMatchObject({ provider: "sub-media" });
      await expect(
        gateway.composeMusic({ presetId: "own-music", prompt: "tavern" }),
      ).resolves.toMatchObject({ provider: "sub-media" });
      expect(ownHeaders).toEqual([
        { authorization: "Bearer owner-oauth-secret" },
        { authorization: "Bearer owner-oauth-secret" },
      ]);
    } finally {
      for (const unregister of unregs) unregister();
    }
  });
});
