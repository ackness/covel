import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  createTypeSafeSystemOneAdapter,
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
      const result = await createTypeSafeSystemOneAdapter().evaluate!(
        { ...config, baseUrl },
        params,
      );
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
        createTypeSafeSystemOneAdapter().evaluate!(config, {
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
      createTypeSafeSystemOneAdapter().evaluate!(config, params),
    ).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
  });

  it("uses the requested ID and empty usage when optional metadata is absent", async () => {
    mockResponse({ answers: responseBody().answers });
    expect(
      await createTypeSafeSystemOneAdapter().evaluate!(config, params),
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
        createTypeSafeSystemOneAdapter().evaluate!(config, params),
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
    const pending = createTypeSafeSystemOneAdapter().evaluate!(config, params);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ model: "jev-1.13.0" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects private endpoints and redirects before following them", async () => {
    const fetchMock = mockResponse();
    await expect(
      createTypeSafeSystemOneAdapter().evaluate!(
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
      createTypeSafeSystemOneAdapter().evaluate!(config, params),
    ).rejects.toThrow(/refusing to follow redirect/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not advertise or send generative requests", async () => {
    const fetchMock = mockResponse();
    const adapter = createTypeSafeSystemOneAdapter();
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
  const slotRegistry = createSlotRegistry({ presetRegistry });
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
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      gateway.evaluate(params, { signal: controller.signal }),
    ).rejects.toThrow();
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
