import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  createEvaluationAdapter,
  parseLlmConfig,
  resolveCapability,
  type EvaluationParams,
} from "../src/index.js";

const config = {
  baseUrl: "https://api.typesafe.ai/v1",
  apiKey: "synthetic-key",
};
const questions = {
  intent: {
    type: "choice",
    instructions: "Classify the action",
    criteria: {
      talk: { action: "conversation" },
      fight: null,
      other: ["unknown"],
    },
  },
  severity: {
    type: "score",
    instructions: "Rate the risk",
    criteria: ["low", "medium", "high"],
  },
  coherent: {
    type: "boolean",
    instructions: "Is the action consistent?",
    criteria: { true: "consistent", false: "contradiction" },
  },
} as const;
const params = {
  model: "jev-latest",
  state: { action: "Talk to the guard" },
  questions,
};
function responseBody() {
  return {
    model: "jev-1.13.0",
    answers: {
      intent: {
        type: "choice",
        choice: "talk",
        probabilities: { talk: 0.8, fight: 0.1, other: 0.1 },
        confidence: 0.7,
      },
      severity: {
        type: "score",
        score: 1,
        probabilities: { "0": 0.33, "1": 0.33, "2": 0.33 },
        legend: { "0": "low", "1": "medium", "2": "high" },
        confidence: 0.01,
      },
      coherent: { type: "noul", noul: 0.92 },
    },
    usage: { input_tokens: 123, output_tokens: 12 },
  };
}
function mockResponse(body: unknown = responseBody()) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("native TypeSafe System One protocol", () => {
  it.each(["https://api.typesafe.ai", "https://api.typesafe.ai/v1/"])(
    "maps typed questions, preserves probabilities and the actual model via %s",
    async (baseUrl) => {
      const fetchMock = mockResponse();
      const result = await createEvaluationAdapter("typesafe-systemone-v1")
        .evaluate!({ ...config, baseUrl }, params);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.typesafe.ai/v1/systemone",
        expect.objectContaining({ method: "POST", redirect: "manual" }),
      );
      const init = fetchMock.mock.calls[0]![1]!;
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer synthetic-key",
      );
      expect(JSON.parse(init.body as string)).toEqual({
        ...params,
        questions: {
          ...questions,
          coherent: { ...questions.coherent, type: "noul" },
        },
      });
      expect(result.model).toBe("jev-1.13.0");
      expect(result.answers.coherent).toEqual({
        type: "boolean",
        probability: 0.92,
      });
      expect(result.answers.severity.probabilities).toEqual({
        "0": 0.33,
        "1": 0.33,
        "2": 0.33,
      });
      expect(result.providerMetadata).toMatchObject({
        typesafe: { confidence: { intent: 0.7, severity: 0.01 } },
      });
      expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 12 });
      expectTypeOf(result.answers.intent.choice).toEqualTypeOf<
        "talk" | "fight" | "other"
      >();
      expectTypeOf(result.answers.coherent.probability).toEqualTypeOf<number>();
    },
  );

  it.each([
    {},
    { item: { type: "score", criteria: ["one"] } },
    {
      item: {
        type: "score",
        criteria: Array.from({ length: 11 }, () => "level"),
      },
    },
    { item: { type: "choice", criteria: {} } },
    {
      item: {
        type: "choice",
        criteria: Object.fromEntries(
          Array.from({ length: 256 }, (_, i) => [String(i), null]),
        ),
      },
    },
    { item: { type: "boolean", instructions: Number.POSITIVE_INFINITY } },
  ])(
    "rejects invalid questions without network I/O: %j",
    async (invalidQuestions) => {
      const fetchMock = mockResponse();
      await expect(
        createEvaluationAdapter("typesafe-systemone-v1").evaluate!(config, {
          ...params,
          questions: invalidQuestions,
        } as unknown as EvaluationParams),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    (body: ReturnType<typeof responseBody>) => {
      delete (body.answers as Record<string, unknown>).coherent;
    },
    (body: ReturnType<typeof responseBody>) => {
      body.answers.coherent.noul = 1.1;
    },
    (body: ReturnType<typeof responseBody>) => {
      body.answers.coherent.type = "boolean";
    },
    (body: ReturnType<typeof responseBody>) => {
      body.answers.intent.choice = "unlisted";
    },
    (body: ReturnType<typeof responseBody>) => {
      body.answers.intent.probabilities.talk = 0;
    },
    (body: ReturnType<typeof responseBody>) => {
      delete (body.answers.intent.probabilities as Record<string, number>)
        .other;
    },
    (body: ReturnType<typeof responseBody>) => {
      body.answers.severity.score = 3;
    },
    (body: ReturnType<typeof responseBody>) => {
      body.usage.input_tokens = -1;
    },
  ])("rejects malformed or mismatched responses", async (mutate) => {
    const body = responseBody();
    mutate(body);
    mockResponse(body);
    await expect(
      createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
        config,
        params,
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("uses the requested ID and empty usage when optional metadata is absent", async () => {
    mockResponse({ answers: responseBody().answers });
    expect(
      await createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
        config,
        params,
      ),
    ).toMatchObject({
      model: "jev-latest",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it.each([401, 422, 429, 529])(
    "preserves HTTP %s even for non-JSON errors",
    async (status) => {
      vi.stubEnv("COVEL_LLM_RETRY_DISABLED", "1");
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("upstream error", { status }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
          config,
          params,
        ),
      ).rejects.toMatchObject({
        statusCode: status,
        code: status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the existing retry transport for overloads", async () => {
    vi.useFakeTimers();
    const fetchMock = mockResponse();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 529, headers: { "retry-after": "1" } }),
    );
    const pending = createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
      config,
      params,
    );
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ model: "jev-1.13.0" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects private endpoints and redirects before following them", async () => {
    const fetchMock = mockResponse();
    await expect(
      createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
        { ...config, baseUrl: "https://169.254.169.254" },
        params,
      ),
    ).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
    );
    await expect(
      createEvaluationAdapter("typesafe-systemone-v1").evaluate!(
        config,
        params,
      ),
    ).rejects.toThrow(/refusing to follow redirect/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not advertise or send generative requests", async () => {
    const fetchMock = mockResponse();
    const adapter = createEvaluationAdapter("typesafe-systemone-v1");
    await expect(
      adapter.generateText(config, { model: "jev-latest", messages: [] }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      resolveCapability("jev-latest", "typesafe", "typesafe-systemone-v1"),
    ).toMatchObject({ output: ["evaluation"], features: [] });
  });
});

function setup(extra = "") {
  const { aiConfig } = parseLlmConfig(`
[covel.evaluation]
provider = "typesafe"
model = "jev-latest"
baseUrl = "https://api.typesafe.ai/v1"
protocol = "typesafe-systemone-v1"
${extra}
`);
  const providerRegistry = createProviderRegistry({
    providerDefaults: aiConfig.providers,
  });
  const presetRegistry = createPresetRegistry(aiConfig);
  const slotRegistry = createSlotRegistry();
  slotRegistry.configure({
    slots: {
      evaluation: {
        slotId: "evaluation",
        presetId: "slot-evaluation",
        tag: "evaluation",
      },
    },
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  return { gateway, aiConfig, providerRegistry, presetRegistry };
}

describe("gateway.evaluate", () => {
  it("routes TOML evaluation slots, binds request keys, and records native requests and usage", async () => {
    const { gateway, aiConfig, providerRegistry } = setup();
    expect(aiConfig.presets[0]).toMatchObject({
      tag: "evaluation",
      supportedModes: ["evaluate"],
    });
    expect(providerRegistry.resolve({ provider: "typesafe" }).protocol).toBe(
      "typesafe-systemone-v1",
    );
    const fetchMock = mockResponse();
    const onProviderRequest = vi.fn();
    const result = await gateway.evaluate(params, {
      apiKeys: { typesafe: "request-fixture" },
      envApiKeys: { typesafe: "env-fixture" },
      onProviderRequest,
    });
    expect(
      new Headers(fetchMock.mock.calls[0]![1]!.headers).get("authorization"),
    ).toBe("Bearer request-fixture");
    expect(result).toMatchObject({ provider: "typesafe", model: "jev-1.13.0" });
    expect(onProviderRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "typesafe-systemone-v1",
        complete: true,
        body: expect.objectContaining({
          state: params.state,
          questions: expect.any(Object),
        }),
      }),
    );
    expect(JSON.stringify(onProviderRequest.mock.calls)).not.toContain(
      "request-fixture",
    );
  });

  it("supports another provider using the same wire through a request overlay without leaking env keys", async () => {
    const { gateway, presetRegistry } = setup();
    const fetchMock = mockResponse();
    await gateway.evaluate(
      { ...params, presetId: "custom-evaluation" },
      {
        envApiKeys: { typesafe: "server-secret-fixture" },
        slotOverrides: {
          customPresets: [
            {
              id: "custom-evaluation",
              name: "Custom",
              provider: "typesafe",
              model: "other-model",
              baseUrl: "https://other.example/v1",
              protocol: "typesafe-systemone-v1",
            },
          ],
        },
      },
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://other.example/v1/systemone",
    );
    expect(
      new Headers(fetchMock.mock.calls[0]![1]!.headers).has("authorization"),
    ).toBe(false);
    expect(presetRegistry.listPresets()).toHaveLength(1);
  });

  it("uses configured evaluation fallbacks but never falls back after cancellation", async () => {
    vi.stubEnv("COVEL_LLM_RETRY_DISABLED", "1");
    const { gateway } = setup(`fallback = "backup"
[covel.backup]
provider = "other"
model = "another-model"
baseUrl = "https://other.example/v1"
protocol = "typesafe-systemone-v1"`);
    const fetchMock = mockResponse();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 529 }));
    expect(await gateway.evaluate(params)).toMatchObject({ provider: "other" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      receivedSignal = init?.signal;
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      gateway.evaluate(params, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(controller.signal.reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a chat target before sending evaluation data", async () => {
    const { gateway, presetRegistry } = setup();
    presetRegistry.addPreset({
      id: "chat",
      name: "Chat",
      enabled: true,
      provider: "openai",
      model: "chat-model",
      tier: "medium",
      supportedModes: ["text"],
    });
    const fetchMock = mockResponse();
    await expect(
      gateway.evaluate({ ...params, presetId: "chat" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("evaluation protocols on shared provider connections", () => {
  it.each([
    [
      "openrouter-decisions-v1",
      "https://openrouter.ai/api/v1",
      "https://openrouter.ai/api/alpha/decisions",
      "typesafe/jev-1.13",
    ],
    [
      "openrouter-decisions-v1",
      "https://router.example/proxy/api/alpha/",
      "https://router.example/proxy/api/alpha/decisions",
      "future/model",
    ],
    [
      "vercel-evaluation-v4",
      "https://ai-gateway.vercel.sh/v1",
      "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
      "typesafe-ai/jev",
    ],
    [
      "vercel-evaluation-v4",
      "https://gateway.example/proxy/v4/ai/",
      "https://gateway.example/proxy/v4/ai/evaluation-model",
      "future/model",
    ],
    // A base that already points at the evaluation endpoint stays idempotent.
    [
      "openrouter-decisions-v1",
      "https://proxy.example/router/api/alpha/decisions",
      "https://proxy.example/router/api/alpha/decisions",
      "typesafe/jev-1.13",
    ],
    [
      "vercel-evaluation-v4",
      "https://proxy.example/gw/v4/ai/evaluation-model",
      "https://proxy.example/gw/v4/ai/evaluation-model",
      "typesafe-ai/jev",
    ],
    [
      "typesafe-systemone-v1",
      "https://proxy.example/rt/v1/systemone",
      "https://proxy.example/rt/v1/systemone",
      "jev-latest",
    ],
  ] as const)(
    "routes %s via %s without rewriting %s",
    async (protocol, baseUrl, endpoint, model) => {
      const vercel = protocol === "vercel-evaluation-v4";
      const fetchMock = mockResponse(
        vercel
          ? {
              answers: {
                ...responseBody().answers,
                coherent: { type: "boolean", probability: 0.92 },
              },
              rounding: { probabilityDecimals: 2 },
              usage: { inputTokens: 123, outputTokens: 12 },
              providerMetadata: { gateway: { cost: "0.001" } },
            }
          : responseBody(),
      );
      const { gateway } = setup();
      const onProviderRequest = vi.fn();
      const result = await gateway.evaluate(
        { ...params, presetId: "evaluation-model" },
        {
          apiKeys: { connection: "synthetic-key" },
          onProviderRequest,
          slotOverrides: {
            customPresets: [
              {
                id: "evaluation-model",
                name: "Evaluation",
                provider: "connection",
                baseUrl,
                model,
                protocol,
              },
            ],
          },
        },
      );
      expect(fetchMock.mock.calls[0]![0]).toBe(endpoint);
      const init = fetchMock.mock.calls[0]![1]!;
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer synthetic-key");
      expect(JSON.parse(init.body as string)).toEqual({
        ...(!vercel ? { model } : {}),
        state: params.state,
        questions: vercel
          ? questions
          : { ...questions, coherent: { ...questions.coherent, type: "noul" } },
      });
      if (vercel) {
        expect(headers.get("ai-model-id")).toBe(model);
        expect(headers.get("ai-gateway-auth-method")).toBe("api-key");
        expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1");
        expect(headers.get("ai-evaluation-model-specification-version")).toBe(
          "4",
        );
        expect(result.providerMetadata).toMatchObject({
          gateway: { cost: "0.001" },
        });
      }
      expect(result).toMatchObject({
        provider: "connection",
        usage: { inputTokens: 123, outputTokens: 12 },
        answers: { coherent: { type: "boolean", probability: 0.92 } },
      });
      expect(onProviderRequest).toHaveBeenCalledWith(
        expect.objectContaining({ protocol, complete: true }),
      );
    },
  );

  it.each(["openrouter-decisions-v1", "vercel-evaluation-v4"] as const)(
    "accepts omitted distributions but rejects invalid supplied distributions through %s",
    async (protocol) => {
      const body = {
        answers: {
          intent: { type: "choice", choice: "talk" },
          severity: { type: "score", score: 1.4 },
          coherent:
            protocol === "vercel-evaluation-v4"
              ? { type: "boolean", probability: 0.9 }
              : { type: "noul", noul: 0.9 },
        },
      };
      mockResponse(body);
      const adapter = createEvaluationAdapter(protocol);
      expect(
        (await adapter.evaluate!(config, params)).answers.intent.probabilities,
      ).toBeUndefined();
      mockResponse({
        ...body,
        answers: {
          ...body.answers,
          intent: { ...body.answers.intent, probabilities: { talk: 1.2 } },
        },
      });
      await expect(adapter.evaluate!(config, params)).rejects.toMatchObject({
        code: "SCHEMA_VALIDATION_FAILED",
      });
    },
  );
});

describe("OpenAI Decisions protocol", () => {
  const adapter = createEvaluationAdapter("openai-decisions-v1");
  const openAiParams = { ...params, model: "gpt-6-luna" };
  function decision(overrides: Record<string, unknown> = {}) {
    return {
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", name: "coherent", probability: 0.92 },
        {
          type: "choice",
          name: "intent",
          choice: "talk",
          confidence: 0.7,
          probabilities: [
            { value: "talk", probability: 0.8 },
            { value: "fight", probability: 0.1 },
            { value: "other", probability: 0.1 },
          ],
        },
        {
          type: "score",
          name: "severity",
          score: 0.4,
          confidence: 0.6,
          probabilities: [
            { label: "0", value: 0, probability: 0.7 },
            { label: "1", value: 1, probability: 0.2 },
            { label: "2", value: 2, probability: 0.1 },
          ],
        },
      ],
      usage: {
        input_tokens: 42,
        input_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 42,
      },
      ...overrides,
    };
  }

  it.each([
    "https://api.openai.com/v1",
    "https://api.openai.com",
    "https://api.openai.com/v1/decisions/",
    "https://proxy.example/openai/v1",
  ])(
    "posts named questions to the decisions endpoint of %s",
    async (baseUrl) => {
      const fetchMock = mockResponse(decision());
      await adapter.evaluate!({ ...config, baseUrl }, openAiParams);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        baseUrl.startsWith("https://proxy")
          ? "https://proxy.example/openai/v1/decisions"
          : "https://api.openai.com/v1/decisions",
      );
      expect(new Headers(init!.headers).get("authorization")).toBe(
        "Bearer synthetic-key",
      );
      expect(JSON.parse(init!.body as string)).toEqual({
        model: "gpt-6-luna",
        input: '{"action":"Talk to the guard"}',
        questions: [
          {
            type: "choice",
            name: "intent",
            instructions: "Classify the action",
            choices: [
              { value: "talk", description: '{"action":"conversation"}' },
              { value: "fight" },
              { value: "other", description: '["unknown"]' },
            ],
          },
          {
            type: "score",
            name: "severity",
            instructions: "Rate the risk",
            levels: [
              { label: "0", description: "low" },
              { label: "1", description: "medium" },
              { label: "2", description: "high" },
            ],
          },
          {
            type: "predicate",
            name: "coherent",
            instructions:
              "Is the action consistent?\n\nCriteria for true:\nconsistent\n\nCriteria for false:\ncontradiction",
          },
        ],
      });
    },
  );

  it("returns the public answers, keyed by question, with cache usage and confidence", async () => {
    mockResponse(decision());
    const result = await adapter.evaluate!(config, openAiParams);

    expect(result.answers).toEqual({
      intent: {
        type: "choice",
        choice: "talk",
        probabilities: { talk: 0.8, fight: 0.1, other: 0.1 },
      },
      severity: {
        type: "score",
        score: 0.4,
        probabilities: { "0": 0.7, "1": 0.2, "2": 0.1 },
      },
      coherent: { type: "boolean", probability: 0.92 },
    });
    expect(result.model).toBe("gpt-6-luna");
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 0,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
    });
    expect(result.providerMetadata).toEqual({
      openai: {
        confidence: { intent: 0.7, severity: 0.6 },
        probabilityDecimals: 2,
        scoreDecimals: 2,
      },
    });
  });

  it("sends a plain-text state as it is", async () => {
    const fetchMock = mockResponse(
      decision({
        answers: [{ type: "predicate", name: "damaged", probability: 0.95 }],
      }),
    );
    await adapter.evaluate!(config, {
      model: "gpt-6-luna",
      state: "The package arrived with a broken screen.",
      questions: {
        damaged: {
          type: "boolean",
          instructions: "Does the customer report a damaged item?",
        },
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      model: "gpt-6-luna",
      input: "The package arrived with a broken screen.",
      questions: [
        {
          type: "predicate",
          name: "damaged",
          instructions: "Does the customer report a damaged item?",
        },
      ],
    });
  });

  it("fails the call as a refusal when the model declines a question", async () => {
    const body = decision();
    body.answers[1] = { type: "refusal", name: "intent" } as never;
    mockResponse(body);
    await expect(adapter.evaluate!(config, openAiParams)).rejects.toMatchObject(
      {
        code: "REFUSAL",
        retriable: false,
        details: { question: "intent" },
      },
    );
  });

  it.each([
    [
      "an answer is missing",
      (body: ReturnType<typeof decision>) => body.answers.pop(),
    ],
    [
      "a name comes twice",
      (body: ReturnType<typeof decision>) => {
        body.answers[2] = { ...body.answers[0]! };
      },
    ],
    [
      "a choice is not one of the options",
      (body: ReturnType<typeof decision>) => {
        (body.answers[1] as { choice: string }).choice = "flee";
      },
    ],
    [
      "a distribution does not add up to 1",
      (body: ReturnType<typeof decision>) => {
        (
          body.answers[1] as { probabilities: { probability: number }[] }
        ).probabilities[0]!.probability = 0.2;
      },
    ],
    [
      "a score is outside the levels",
      (body: ReturnType<typeof decision>) => {
        (body.answers[2] as { score: number }).score = 2.5;
      },
    ],
  ])("rejects a response in which %s", async (_name, corrupt) => {
    const body = decision();
    corrupt(body);
    mockResponse(body);
    await expect(adapter.evaluate!(config, openAiParams)).rejects.toMatchObject(
      { code: "SCHEMA_VALIDATION_FAILED" },
    );
  });

  it("refuses a one-option choice before sending, as the API takes 2-255", async () => {
    const fetchMock = mockResponse(decision());
    await expect(
      adapter.evaluate!(config, {
        model: "gpt-6-luna",
        state: "x",
        questions: {
          only: { type: "choice", instructions: "Pick", criteria: { a: "A" } },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is the evaluation protocol an `openai` slot gets from llm.toml", () => {
    const { aiConfig } = parseLlmConfig(`
[covel.evaluation]
provider = "openai"
model = "gpt-6-luna"
protocol = "openai-decisions-v1"
`);
    expect(aiConfig.presets[0]).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-decisions-v1",
      tag: "evaluation",
      supportedModes: ["evaluate"],
    });
  });
});
