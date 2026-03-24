import { z, type ZodType } from "zod";

import { type ModelProfile, type PresetMetadata, type SupportedMode } from "./model-profile-registry.js";

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface TextGenerationParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
  providerRequestMetadata?: Record<string, unknown>;
}

export interface ObjectGenerationParams<TObject> extends TextGenerationParams {
  schema: ZodType<TObject>;
}

export interface ModelRequestContext {
  profile: ModelProfile;
  preset: PresetMetadata | null;
  mode: SupportedMode;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage: UsageSummary;
}

export type StreamEvent =
  | {
      type: "text-delta";
      textDelta: string;
    }
  | {
      type: "done";
      finishReason: string;
      usage: UsageSummary;
    };

export interface ModelProviderAdapter {
  generateText(
    config: ProviderConfig,
    params: TextGenerationParams,
    context: ModelRequestContext
  ): Promise<{
    text: string;
    finishReason: string;
    usage: UsageSummary;
  }>;
  generateObject(
    config: ProviderConfig,
    params: ObjectGenerationParams<any>,
    context: ModelRequestContext
  ): Promise<{
    object: any;
    finishReason: string;
    usage: UsageSummary;
  }>;
  streamText(
    config: ProviderConfig,
    params: TextGenerationParams,
    context: ModelRequestContext
  ): AsyncIterable<StreamEvent>;
  embed(
    config: ProviderConfig,
    params: {
      model: string;
      values: string[];
      providerRequestMetadata?: Record<string, unknown>;
    },
    context: ModelRequestContext
  ): Promise<EmbeddingResult>;
}

export function createProviderRegistry(options?: {
  providers?: Record<
    string,
    {
      adapter?: ModelProviderAdapter;
      defaults?: ProviderConfig;
    }
  >;
}) {
  const providers = new Map(
    Object.entries(options?.providers ?? {}).map(([name, entry]) => [name, entry] as const)
  );

  function resolve<TTarget extends { provider: string; baseUrl?: string }>(target: TTarget): {
    adapter: ModelProviderAdapter;
    config: ProviderConfig;
  } {
    const registered = providers.get(target.provider);
    if (!registered) {
      throw new Error(`Provider registry error: provider "${target.provider}" is not registered.`);
    }

    const adapter =
      registered.adapter ?? (target.provider === "openaiCompatible" ? createOpenAiCompatibleAdapter() : null);

    if (!adapter) {
      throw new Error(`Provider registry error: provider "${target.provider}" has no adapter.`);
    }

    return {
      adapter,
      config: {
        ...registered.defaults,
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {})
      }
    };
  }

  return {
    resolve
  };
}

function createOpenAiCompatibleAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      return {
        text: readAssistantContent(payload),
        finishReason: readFinishReason(payload),
        usage: readUsage(payload)
      };
    },
    async generateObject(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        response_format: {
          type: "json_object"
        },
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      const rawObject = JSON.parse(readAssistantContent(payload));
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw new Error(JSON.stringify({
          name: "ModelGatewayError",
          code: "SCHEMA_VALIDATION_FAILED",
          provider: "openaiCompatible",
          retriable: false
        }));
      }

      return {
        object: validation.data,
        finishReason: readFinishReason(payload),
        usage: readUsage(payload)
      };
    },
    async *streamText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        stream: true,
        ...params.providerRequestMetadata
      });
      const text = await response.text();
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"));

      let usage: UsageSummary = {
        inputTokens: 0,
        outputTokens: 0
      };
      let finishReason = "stop";

      for (const line of lines) {
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") {
          continue;
        }

        const payload = JSON.parse(data) as Record<string, unknown>;
        const delta = readStreamDelta(payload);
        if (delta) {
          yield {
            type: "text-delta",
            textDelta: delta
          };
        }

        if ("usage" in payload && payload.usage && typeof payload.usage === "object") {
          usage = {
            inputTokens: Number((payload.usage as Record<string, unknown>).prompt_tokens ?? 0),
            outputTokens: Number((payload.usage as Record<string, unknown>).completion_tokens ?? 0)
          };
        }

        const candidateFinishReason = readStreamFinishReason(payload);
        if (candidateFinishReason) {
          finishReason = candidateFinishReason;
        }
      }

      yield {
        type: "done",
        finishReason,
        usage
      };
    },
    async embed(config, params) {
      const response = await postJson(config, "/embeddings", {
        model: params.model,
        input: params.values,
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        embeddings: data.map((entry) => (entry as { embedding: number[] }).embedding),
        usage: {
          inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
          outputTokens: 0
        }
      };
    }
  };
}

async function postJson(
  config: ProviderConfig,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  if (!config.baseUrl) {
    throw new Error("Provider registry error: baseUrl is required.");
  }

  return fetch(buildProviderUrl(config.baseUrl, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers
    },
    body: JSON.stringify(body)
  });
}

function buildProviderUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

async function parseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function assertSuccess(
  response: Response,
  payload: Record<string, any>,
  provider: string
): void {
  if (response.ok) {
    return;
  }

  const errorType = payload.error?.type;
  const isRateLimit = response.status === 429 || errorType === "rate_limit_error";
  const error = {
    name: "ModelGatewayError",
    code: isRateLimit ? "RATE_LIMITED" : "PROVIDER_ERROR",
    provider,
    retriable: isRateLimit || response.status >= 500,
    statusCode: response.status
  };
  throw new Error(JSON.stringify(error));
}

function readAssistantContent(payload: Record<string, any>): string {
  return String(payload.choices?.[0]?.message?.content ?? "");
}

function readFinishReason(payload: Record<string, any>): string {
  return String(payload.choices?.[0]?.finish_reason ?? "stop");
}

function readUsage(payload: Record<string, any>): UsageSummary {
  return {
    inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
    outputTokens: Number(payload.usage?.completion_tokens ?? 0)
  };
}

function readStreamDelta(payload: Record<string, unknown>): string | null {
  const delta = (payload.choices as Array<Record<string, any>> | undefined)?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : null;
}

function readStreamFinishReason(payload: Record<string, unknown>): string | null {
  const finishReason = (payload.choices as Array<Record<string, any>> | undefined)?.[0]?.finish_reason;
  return typeof finishReason === "string" ? finishReason : null;
}
