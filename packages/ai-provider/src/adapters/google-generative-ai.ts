import type { ModelProviderAdapter } from "./adapter.js";
import type { LLMProviderWarning } from "@covel/shared";
import type {
  ModelRequestContext,
  ProviderConfig,
  TextGenerationParams,
} from "../types.js";
import { AiProviderError } from "../errors.js";
import {
  extractReasoningRequestFields,
  readReasoningEffort,
} from "../reasoning-effort.js";
import { extractParameterOverrides } from "./common.js";
import {
  postJson,
  parseJson,
  assertSuccess,
  iterateSsePayloads,
  createUnsupportedModeError,
} from "./http.js";
import { withTextRequestDefaults } from "./request-defaults.js";
import { objectResponseFormat } from "./structured-output.js";
import { googleMessages } from "./google-messages.js";
import { applyCapabilityFallback } from "./capability-fallback.js";
import { withProviderWarnings } from "../provider-options.js";
import {
  GOOGLE_PROTOCOL,
  GOOGLE_PROVIDER,
  googleError,
  GoogleResponse,
} from "./google-response.js";

const PARAMETER_FIELDS = {
  temperature: "temperature",
  topP: "topP",
  topK: "topK",
  maxOutputTokens: "maxOutputTokens",
  frequencyPenalty: "frequencyPenalty",
  presencePenalty: "presencePenalty",
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Normalize only JSON Schema keywords, never property names or user values. */
function responseSchema(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const schema = { ...record(value) };
  if (Object.hasOwn(schema, "const")) {
    schema.enum = [schema.const];
    delete schema.const;
  }
  for (const key of [
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
  ]) {
    if (schema[key] && typeof schema[key] === "object")
      schema[key] = Object.fromEntries(
        Object.entries(record(schema[key])).map(([name, child]) => [
          name,
          responseSchema(child),
        ]),
      );
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(schema[key]))
      schema[key] = schema[key].map(responseSchema);
  }
  for (const key of [
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
  ]) {
    if (schema[key] !== undefined)
      schema[key] = Array.isArray(schema[key])
        ? schema[key].map(responseSchema)
        : responseSchema(schema[key]);
  }
  return schema;
}

function requestBody(
  config: ProviderConfig,
  original: TextGenerationParams,
  context?: ModelRequestContext,
  warnings: LLMProviderWarning[] = [],
): Record<string, unknown> {
  const params = withTextRequestDefaults(original);
  const meta = params.providerRequestMetadata ?? {};
  const native = record(meta.generationConfig);
  const generationConfig: Record<string, unknown> = {};
  // Whitelist supported native generation options; canonical schema and token
  // limit are owned by the request contract, not a raw nested metadata object.
  for (const key of [
    "temperature",
    "topP",
    "topK",
    "frequencyPenalty",
    "presencePenalty",
    "stopSequences",
    "seed",
  ]) {
    if (native[key] !== undefined) generationConfig[key] = native[key];
    if (meta[key] !== undefined) generationConfig[key] = meta[key];
  }
  if (meta.maxOutputTokens !== undefined)
    generationConfig.maxOutputTokens = meta.maxOutputTokens;
  Object.assign(
    generationConfig,
    extractParameterOverrides(meta, PARAMETER_FIELDS),
  );
  // Gemini 2.5 Developer API rejects these standard settings (Vertex differs).
  if (/^(?:models\/)?gemini-2\.5(?:-|$)/i.test(params.model)) {
    for (const feature of ["frequencyPenalty", "presencePenalty"]) {
      if (generationConfig[feature] !== undefined) {
        delete generationConfig[feature];
        warnings.push({
          type: "unsupported",
          feature,
          message:
            "Gemini 2.5 Developer API does not support this parameter; it was ignored.",
        });
      }
    }
  }
  const thinkingConfig = {
    ...record(meta.thinkingConfig ?? native.thinkingConfig),
  };
  // Unified selection replaces inherited native budget/level, preserving the
  // independent summary preference. provider-default is an explicit opt-out.
  if (readReasoningEffort(meta)) {
    delete thinkingConfig.thinkingBudget;
    delete thinkingConfig.thinkingLevel;
  }
  Object.assign(
    thinkingConfig,
    record(
      extractReasoningRequestFields(
        meta,
        context,
        GOOGLE_PROTOCOL,
        params.model,
      ).thinkingConfig,
    ),
  );
  if (Object.keys(thinkingConfig).length)
    generationConfig.thinkingConfig = thinkingConfig;
  if (params.responseFormat) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = responseSchema(
      params.responseFormat.schema,
    );
  }
  const body: Record<string, unknown> = {
    ...googleMessages(
      applyCapabilityFallback(params.messages, context),
      config,
      params.model,
    ),
    generationConfig,
  };
  for (const key of ["cachedContent", "safetySettings", "labels"])
    if (meta[key] !== undefined) body[key] = meta[key];
  if (params.tools?.length) {
    body.tools = [
      {
        functionDeclarations: params.tools.map((tool) => ({
          name: tool.function.name,
          ...(tool.function.description
            ? { description: tool.function.description }
            : {}),
          ...(tool.function.parameters
            ? { parametersJsonSchema: responseSchema(tool.function.parameters) }
            : {}),
        })),
      },
    ];
    const choice = params.defaults?.toolChoice;
    body.toolConfig = meta.toolConfig ?? {
      functionCallingConfig: {
        mode:
          choice === "required" || (typeof choice === "object" && choice.name)
            ? "ANY"
            : "AUTO",
        ...(typeof choice === "object" && choice.name
          ? { allowedFunctionNames: [choice.name] }
          : {}),
      },
    };
  }
  return body;
}

async function send(
  config: ProviderConfig,
  model: string,
  body: Record<string, unknown>,
  stream = false,
): Promise<Response> {
  // Model is a path component, never an arbitrary endpoint or query string.
  const id = model.replace(/^models\//, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(id))
    throw googleError("Invalid Gemini model identifier", true);
  const baseUrl = new URL(
    config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
  );
  if (stream) baseUrl.searchParams.set("alt", "sse");
  const wireConfig = {
    ...config,
    baseUrl: baseUrl.toString(),
    apiKey: undefined,
  };
  return postJson(
    wireConfig,
    {
      append: `/models/${id}:${stream ? "streamGenerateContent" : "generateContent"}`,
    },
    body,
    undefined,
    config.apiKey ? { "x-goog-api-key": config.apiKey } : undefined,
  );
}

/** Native Gemini Developer API; no OpenAI-compatible endpoint assumptions. */
export function createGoogleGenerativeAiAdapter(): ModelProviderAdapter {
  const adapter: ModelProviderAdapter = {
    async generateText(config, params, context) {
      const warnings: LLMProviderWarning[] = [];
      const response = await send(
        config,
        params.model,
        requestBody(config, params, context, warnings),
      );
      const payload = await parseJson(response);
      assertSuccess(response, payload, GOOGLE_PROVIDER);
      const result = new GoogleResponse();
      result.push(payload);
      return withProviderWarnings(
        result.result(config, params.model),
        warnings,
      );
    },
    async generateObject(config, params, context) {
      const result = await adapter.generateText(
        config,
        {
          ...params,
          responseFormat: objectResponseFormat(params.schema, GOOGLE_PROVIDER),
        },
        context,
      );
      let value: unknown;
      try {
        value = JSON.parse(result.text);
      } catch (cause) {
        throw new AiProviderError({
          code: "SCHEMA_VALIDATION_FAILED",
          message: "Gemini returned invalid JSON",
          provider: GOOGLE_PROVIDER,
          retriable: false,
          cause,
        });
      }
      const parsed = params.schema.safeParse(value);
      if (!parsed.success)
        throw new AiProviderError({
          code: "SCHEMA_VALIDATION_FAILED",
          message: "Gemini output does not match the requested schema",
          provider: GOOGLE_PROVIDER,
          retriable: false,
          cause: parsed.error,
        });
      const { text: _text, toolCalls: _toolCalls, ...rest } = result;
      return { ...rest, object: parsed.data };
    },
    async *streamText(config, params, context) {
      const warnings: LLMProviderWarning[] = [];
      const response = await send(
        config,
        params.model,
        requestBody(config, params, context, warnings),
        true,
      );
      if (!response.ok)
        assertSuccess(response, await parseJson(response), GOOGLE_PROVIDER);
      const accumulator = new GoogleResponse();
      for await (const payload of iterateSsePayloads(response)) {
        for (const part of accumulator.push(payload)) {
          // Gemini sends a call whole, but several can arrive over time.
          if (
            part.functionCall?.args &&
            Object.keys(part.functionCall.args).length
          )
            yield { type: "tool-argument-delta" };
          if (part.text)
            yield part.thought
              ? { type: "reasoning-delta", reasoningDelta: part.text }
              : { type: "text-delta", textDelta: part.text };
        }
      }
      const result = withProviderWarnings(
        accumulator.result(config, params.model),
        warnings,
      );
      for (const tool of result.toolCalls ?? [])
        yield { type: "tool-call", ...tool };
      const { text: _text, toolCalls: _toolCalls, ...done } = result;
      yield { type: "done", ...done };
    },
    async embed() {
      throw createUnsupportedModeError(GOOGLE_PROVIDER, "embed");
    },
  };
  return adapter;
}
