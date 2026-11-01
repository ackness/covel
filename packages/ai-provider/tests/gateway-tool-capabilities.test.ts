import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  parseLlmConfig,
  type ModelProviderAdapter,
  type ModelFeature,
  type PresetConfig,
  type TextGenerationParams,
} from "../src/index.js";
import { closedSchema, strictCapability } from "./strict-tool-fixture.js";

const submission = {
  type: "function" as const,
  strict: "auto" as const,
  function: {
    name: "submit-output",
    description: "Submit result",
    parameters: closedSchema,
  },
};
const input = {
  messages: [{ role: "user", content: "Submit a result" }],
  tools: [submission],
};
const result = {
  text: "",
  finishReason: "tool_calls",
  usage: { inputTokens: 1, outputTokens: 1 },
  toolCalls: [{ id: "call", name: "submit-output", arguments: '{"ok":true}' }],
};

function preset(id: string, features?: ModelFeature[]): PresetConfig {
  return {
    id,
    name: id,
    provider: "fixture",
    model: id,
    enabled: true,
    isDefault: id === "primary",
    supportedModes: ["text", "stream", "object"],
    tier: "medium",
    tag: "text",
    capability: { input: ["text"], output: ["text"], features },
  };
}

function setup(presets: PresetConfig[]) {
  const calls: TextGenerationParams[] = [];
  const adapter: ModelProviderAdapter = {
    async generateText(_config, params) {
      calls.push(params);
      return result;
    },
    async *streamText(_config, params) {
      calls.push(params);
      yield { type: "tool-call", ...result.toolCalls[0]! };
      yield { type: "done", finishReason: "tool_calls", usage: result.usage };
    },
    generateObject: vi.fn(),
    embed: vi.fn(),
  };
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: {
        adapter,
        defaults: {
          baseUrl: strictCapability.baseUrl,
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  return {
    calls,
    gateway: createGateway({
      providerRegistry,
      presetRegistry: createPresetRegistry({ profiles: [], presets }),
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each([false, true])(
  "actual target tools (streaming=%s)",
  (streaming) => {
    async function run(
      gateway: ReturnType<typeof createGateway>,
      options?: Parameters<typeof gateway.generateText>[1],
    ) {
      if (streaming) return Array.fromAsync(gateway.streamText(input, options));
      return gateway.generateText(input, options);
    }
    it("skips a known tool-less primary and selects an eligible configured fallback", async () => {
      const primary = {
        ...preset("primary", []),
        fallbackPresetIds: ["backup"],
      };
      const { gateway, calls } = setup([
        primary,
        preset("backup", ["function_calling"]),
      ]);
      await run(gateway);
      expect(calls.map((call) => call.model)).toEqual(["backup"]);
      expect(calls[0]?.tools?.[0]?.function.strict).toBe(false);
    });
    it("attributes an unsupported final target and never sends impossible tools", async () => {
      const { gateway, calls } = setup([
        { ...preset("primary", []), fallbackPresetIds: ["backup"] },
        preset("backup", []),
      ]);
      await expect(run(gateway)).rejects.toMatchObject({
        code: "CONFIG_ERROR",
        model: "backup",
        provider: "fixture",
        retriable: false,
        details: { unsupportedCapability: "function_calling" },
      });
      expect(calls).toEqual([]);
    });
    it("honors disabled fallback and does not cross tags", async () => {
      const presets = [
        { ...preset("primary", []), fallbackPresetIds: ["backup"] },
        preset("backup", ["function_calling"]),
      ];
      const disabled = setup(presets);
      await expect(
        run(disabled.gateway, { allowFallback: false }),
      ).rejects.toMatchObject({ model: "primary" });
      const crossTag = setup([
        presets[0]!,
        { ...presets[1]!, tag: "evaluation" },
      ]);
      await expect(run(crossTag.gateway)).rejects.toMatchObject({
        model: "primary",
      });
      expect(disabled.calls).toEqual([]);
      expect(crossTag.calls).toEqual([]);
    });
    it("retains conservative non-strict behavior for unknown tool support", async () => {
      const { gateway, calls } = setup([preset("primary")]);
      await run(gateway);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.tools?.[0]?.function.strict).toBe(false);
    });
    it("selects strict independently on a programmatic fallback target", async () => {
      const capable = preset("synthetic", ["function_calling"]);
      capable.capability = {
        ...capable.capability!,
        strictTools: strictCapability,
      };
      const { gateway, calls } = setup([
        { ...preset("primary", []), fallbackPresetIds: ["synthetic"] },
        capable,
      ]);
      await run(gateway);
      expect(calls[0]?.tools?.[0]?.function.strict).toBe(true);
      expect(calls[0]?.tools?.[0]).not.toHaveProperty("strict");
      expect(calls[0]?.tools?.[0]?.function.parameters).toBe(closedSchema);
    });
  },
);

it("keeps text-only calls on tool-less targets available", async () => {
  const { gateway, calls } = setup([preset("primary", [])]);
  await gateway.generateText({ messages: input.messages });
  expect(calls).toHaveLength(1);
});

it("keeps an incompatible generated schema unchanged and reports bounded profile paths", async () => {
  const capable = preset("synthetic", ["function_calling"]);
  capable.capability = {
    ...capable.capability!,
    strictTools: strictCapability,
  };
  const { gateway, calls } = setup([{ ...capable, isDefault: true }]);
  const schema = {
    type: "object",
    properties: { optional: { type: "string" } },
  };
  const generated = await gateway.generateText({
    ...input,
    tools: [
      {
        ...submission,
        function: { ...submission.function, parameters: schema },
      },
    ],
  });
  expect(calls[0]?.tools?.[0]?.function).toMatchObject({
    parameters: schema,
    strict: false,
  });
  expect(schema).toEqual({
    type: "object",
    properties: { optional: { type: "string" } },
  });
  expect(generated.diagnostics?.warnings).toContainEqual(
    expect.objectContaining({
      feature: "strictTools",
      type: "compatibility",
      message: expect.stringContaining("#/additionalProperties"),
    }),
  );
});

it("fails an unexpected strict schema 400 once without changing schemas or endpoints", async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { error: { message: "Unsupported strict schema" } },
        { status: 400 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const capable = {
    ...preset("primary", ["function_calling"]),
    model: "synthetic",
    protocol: "openai-chat-v1" as const,
    fallbackPresetIds: ["backup"],
  };
  capable.capability = {
    ...capable.capability!,
    strictTools: strictCapability,
  };
  const gateway = createGateway({
    providerRegistry: createProviderRegistry({
      providerDefaults: {
        fixture: {
          baseUrl: strictCapability.baseUrl,
          protocol: "openai-chat-v1",
        },
      },
    }),
    presetRegistry: createPresetRegistry({
      profiles: [],
      presets: [capable, preset("backup", ["function_calling"])],
    }),
  });
  await expect(gateway.generateText(input)).rejects.toMatchObject({
    statusCode: 400,
    retriable: false,
    model: "synthetic",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `${strictCapability.baseUrl}/chat/completions`,
  );
  expect(
    JSON.parse(fetcher.mock.calls[0]![1]!.body as string).tools[0].function,
  ).toMatchObject({ parameters: closedSchema, strict: true });
});

describe.each([
  "openai-chat-v1",
  "openai-responses-v1",
  "anthropic-messages-v1",
  "google-generative-ai-v1",
] as const)("%s submission wire", (protocol) => {
  it.each([false, true])(
    "serializes only a compatible verified tool with strict=%s",
    async (strict) => {
      const fetcher = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          Response.json({
            choices: [{ message: { content: "" }, finish_reason: "stop" }],
            status: "completed",
            output: [],
            content: [],
            stop_reason: "end_turn",
            candidates: [
              { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
            ],
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      const nativePreset = {
        ...preset("primary", ["function_calling"]),
        model: "synthetic",
        protocol,
        capability: {
          input: ["text"] as ["text"],
          output: ["text"] as ["text"],
          features: ["function_calling"] as ["function_calling"],
          ...(strict ? { strictTools: { ...strictCapability, protocol } } : {}),
        },
      };
      const gateway = createGateway({
        providerRegistry: createProviderRegistry({
          providerDefaults: {
            fixture: { baseUrl: strictCapability.baseUrl, protocol },
          },
        }),
        presetRegistry: createPresetRegistry({
          profiles: [],
          presets: [nativePreset],
        }),
      });
      await gateway.generateText({
        ...input,
        tools: [
          ...input.tools,
          {
            type: "function",
            function: { name: "business", parameters: closedSchema },
          },
        ],
      });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      if (protocol === "google-generative-ai-v1") {
        expect(body.tools[0].functionDeclarations[0]).not.toHaveProperty(
          "strict",
        );
        expect(body.generationConfig).not.toHaveProperty("responseMimeType");
      } else {
        const tool =
          protocol === "openai-chat-v1"
            ? body.tools[0].function
            : body.tools[0];
        expect(tool.strict ?? false).toBe(strict);
        expect(
          protocol === "anthropic-messages-v1"
            ? tool.input_schema
            : tool.parameters,
        ).toEqual(closedSchema);
        const business =
          protocol === "openai-chat-v1"
            ? body.tools[1].function
            : body.tools[1];
        expect(business.strict).toBe(
          protocol === "openai-responses-v1" ? false : undefined,
        );
      }
      expect(body).not.toHaveProperty("response_format");
      expect(body.text).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("<response-format>");
      expect(fetcher.mock.calls[0]?.[0]).toContain(strictCapability.baseUrl);
    },
  );
});

it("loads explicit strict profiles from host configuration without inferred provider facts", () => {
  const profile = strictCapability.profile;
  const { aiConfig } = parseLlmConfig(`
[covel.main]
provider = "fixture"
model = "synthetic"
baseUrl = "https://fixture.invalid/v1"
[covel.main.strictTools]
provider = "fixture"
model = "synthetic"
protocol = "openai-chat-v1"
baseUrl = "https://fixture.invalid/v1"
[covel.main.strictTools.profile]
id = "synthetic-closed-objects"
keywords = ${JSON.stringify(profile.keywords)}
root = "object"
requireAllProperties = true
closedObjects = true
references = "none"
typeUnions = false
booleanSchemas = false
formats = []
maxBytes = 10000
maxDepth = 10
maxProperties = 30
maxEnumValues = 30
`);
  expect(aiConfig.presets[0]?.capability?.strictTools).toEqual(
    strictCapability,
  );
});
