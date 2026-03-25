import { z, type ZodType } from "zod";

import {
  type ModelProfile,
  type PresetMetadata,
  type ProviderProtocol,
  type SupportedMode
} from "./model-profile-registry.js";

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

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  providerRequestMetadata?: Record<string, unknown>;
}

export interface GeneratedImage {
  mimeType: string;
  dataBase64?: string;
  url?: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  usage: UsageSummary | null;
}

export interface SpeechSynthesisParams {
  model: string;
  text: string;
  voice?: string;
  format?: string;
  providerRequestMetadata?: Record<string, unknown>;
}

export interface SpeechSynthesisResult {
  audio: {
    mimeType: string;
    data: Uint8Array;
  };
  usage: UsageSummary | null;
}

export interface TranscriptionParams {
  model: string;
  audio: {
    data: Uint8Array;
    mimeType: string;
    fileName?: string;
  };
  providerRequestMetadata?: Record<string, unknown>;
}

export interface TranscriptionResult {
  text: string;
  usage: UsageSummary | null;
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
  generateImage(
    config: ProviderConfig,
    params: ImageGenerationParams,
    context: ModelRequestContext
  ): Promise<ImageGenerationResult>;
  synthesizeSpeech(
    config: ProviderConfig,
    params: SpeechSynthesisParams,
    context: ModelRequestContext
  ): Promise<SpeechSynthesisResult>;
  transcribeAudio(
    config: ProviderConfig,
    params: TranscriptionParams,
    context: ModelRequestContext
  ): Promise<TranscriptionResult>;
}

export interface ProviderLifecycleHook {
  onRequestStart?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: SupportedMode;
    model: string;
  }): void | Promise<void>;
  onRequestSuccess?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: SupportedMode;
    model: string;
    usage: UsageSummary | null;
  }): void | Promise<void>;
  onRequestError?(event: {
    provider: string;
    protocol: ProviderProtocol;
    mode: SupportedMode;
    model: string;
    error: unknown;
  }): void | Promise<void>;
}

interface ProtocolRouteRegistration {
  adapter?: ModelProviderAdapter;
  defaults?: ProviderConfig;
}

interface ProviderRegistration {
  adapter?: ModelProviderAdapter;
  defaults?: ProviderConfig;
  protocols?: Partial<Record<ProviderProtocol, ProtocolRouteRegistration>>;
  hooks?: ProviderLifecycleHook[];
}

export function createProviderRegistry(options?: {
  providers?: Record<string, ProviderRegistration>;
}) {
  const providers = new Map(
    Object.entries(options?.providers ?? {}).map(([name, entry]) => [name, entry] as const)
  );

  function resolve<TTarget extends { provider: string; baseUrl?: string; protocol?: ProviderProtocol }>(
    target: TTarget,
    options: {
      mode: SupportedMode;
    } = {
      mode: "text"
    }
  ): {
    adapter: ModelProviderAdapter;
    config: ProviderConfig;
    protocol: ProviderProtocol;
    hooks: ProviderLifecycleHook[];
  } {
    const registered = providers.get(target.provider);
    if (!registered) {
      throw new Error(`Provider registry error: provider "${target.provider}" is not registered.`);
    }

    const protocol = resolveProtocol(target, options.mode);
    const protocolRegistration = registered.protocols?.[protocol];
    const adapter =
      protocolRegistration?.adapter ??
      registered.adapter ??
      builtinProtocolAdapter(protocol);

    if (!adapter) {
      throw new Error(
        `Provider registry error: protocol "${protocol}" is not supported for provider "${target.provider}".`
      );
    }

    return {
      adapter,
      config: normalizeResolvedConfig({
        ...registered.defaults,
        ...protocolRegistration?.defaults,
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {})
      }),
      protocol,
      hooks: [...(registered.hooks ?? [])]
    };
  }

  return {
    resolve
  };
}

function resolveProtocol(
  target: { provider: string; protocol?: ProviderProtocol },
  mode: SupportedMode
): ProviderProtocol {
  if (target.protocol) {
    return target.protocol;
  }

  if (target.provider === "anthropic") {
    return "anthropic-messages-v1";
  }

  if (mode === "embed") {
    return "openai-chat-v1";
  }

  return "openai-chat-v1";
}

function normalizeResolvedConfig(config: ProviderConfig): ProviderConfig {
  if (config.apiKey && config.baseUrl === "in-memory://demo-provider") {
    return {
      ...config,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    };
  }

  return config;
}

function builtinProtocolAdapter(protocol: ProviderProtocol): ModelProviderAdapter | null {
  switch (protocol) {
    case "openai-chat-v1":
      return createOpenAiChatV1Adapter();
    case "openai-responses-v1":
      return createOpenAiResponsesV1Adapter();
    case "anthropic-messages-v1":
      return createAnthropicMessagesV1Adapter();
    default:
      return null;
  }
}

function createOpenAiChatV1Adapter(): ModelProviderAdapter {
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
        text: readOpenAiChatAssistantText(payload),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload)
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

      const rawObject = JSON.parse(readOpenAiChatAssistantText(payload));
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openaiCompatible");
      }

      return {
        object: validation.data,
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload)
      };
    },
    async *streamText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        stream: true,
        ...params.providerRequestMetadata
      });

      let usage: UsageSummary = {
        inputTokens: 0,
        outputTokens: 0
      };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const delta = readOpenAiChatStreamDelta(payload);
        if (delta) {
          yield {
            type: "text-delta",
            textDelta: delta
          };
        }

        if (payload.usage && typeof payload.usage === "object") {
          usage = {
            inputTokens: Number(payload.usage.prompt_tokens ?? 0),
            outputTokens: Number(payload.usage.completion_tokens ?? 0)
          };
        }

        const candidateFinishReason = readOpenAiChatStreamFinishReason(payload);
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
    },
    async generateImage(config, params) {
      const response = await postJson(config, "/images/generations", {
        model: params.model,
        prompt: params.prompt,
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        images: data
          .map((entry) => ({
            mimeType: typeof entry.mime_type === "string" ? entry.mime_type : "image/png",
            ...(typeof entry.b64_json === "string" ? { dataBase64: entry.b64_json } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {})
          }))
          .filter((entry) => entry.dataBase64 || entry.url),
        usage: readOpenAiChatUsage(payload)
      };
    },
    async synthesizeSpeech(config, params) {
      const response = await postJson(config, "/audio/speech", {
        model: params.model,
        input: params.text,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...params.providerRequestMetadata
      });

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openaiCompatible");
      }

      return {
        audio: {
          mimeType: response.headers.get("content-type") ?? "audio/mpeg",
          data: new Uint8Array(await response.arrayBuffer())
        },
        usage: null
      };
    },
    async transcribeAudio(config, params) {
      const formData = new FormData();
      formData.set("model", params.model);
      formData.set(
        "file",
        new Blob([params.audio.data.buffer as ArrayBuffer], {
          type: params.audio.mimeType
        }),
        params.audio.fileName ?? "audio.bin"
      );
      appendProviderRequestMetadata(formData, params.providerRequestMetadata);

      const response = await postFormData(config, "/audio/transcriptions", formData);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      return {
        text: String(payload.text ?? ""),
        usage: payload.usage && typeof payload.usage === "object"
          ? {
              inputTokens: Number(payload.usage.prompt_tokens ?? 0),
              outputTokens: Number(payload.usage.completion_tokens ?? 0)
            }
          : null
      };
    }
  };
}

function createOpenAiResponsesV1Adapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: params.messages,
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      return {
        text: readResponsesOutputText(payload),
        finishReason: "stop",
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0)
        }
      };
    },
    async generateObject(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: params.messages,
        text: {
          format: {
            type: "json_schema"
          }
        },
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openaiCompatible");

      const rawObject = JSON.parse(readResponsesOutputText(payload));
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openaiCompatible");
      }

      return {
        object: validation.data,
        finishReason: "stop",
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0)
        }
      };
    },
    async *streamText(config, params) {
      // Responses streaming emits semantic event types instead of chat deltas.
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: params.messages,
        stream: true,
        ...params.providerRequestMetadata
      });

      let usage: UsageSummary = {
        inputTokens: 0,
        outputTokens: 0
      };

      for await (const payload of iterateSsePayloads(response)) {
        if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
          yield {
            type: "text-delta",
            textDelta: payload.delta
          };
        }

        if (payload.type === "response.completed") {
          usage = {
            inputTokens: Number(payload.response?.usage?.input_tokens ?? 0),
            outputTokens: Number(payload.response?.usage?.output_tokens ?? 0)
          };
        }
      }

      yield {
        type: "done",
        finishReason: "stop",
        usage
      };
    },
    async embed(config, params, context) {
      return createOpenAiChatV1Adapter().embed(config, params, context);
    },
    async generateImage(config, params, context) {
      return createOpenAiChatV1Adapter().generateImage(config, params, context);
    },
    async synthesizeSpeech(config, params, context) {
      return createOpenAiChatV1Adapter().synthesizeSpeech(config, params, context);
    },
    async transcribeAudio(config, params, context) {
      return createOpenAiChatV1Adapter().transcribeAudio(config, params, context);
    }
  };
}

function createAnthropicMessagesV1Adapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      return {
        text: readAnthropicText(payload),
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0)
        }
      };
    },
    async generateObject(config, params) {
      // Messages API has no native json_schema mode, so object generation stays prompt-driven.
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        system: "Respond with JSON only.",
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      const rawObject = JSON.parse(readAnthropicText(payload));
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("anthropic");
      }

      return {
        object: validation.data,
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0)
        }
      };
    },
    async *streamText(config, params) {
      // Anthropic streams text through content_block_delta and closes with message_delta/message_stop.
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        stream: true,
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata
      });

      let usage: UsageSummary = {
        inputTokens: 0,
        outputTokens: 0
      };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        if (
          payload.type === "content_block_delta" &&
          payload.delta?.type === "text_delta" &&
          typeof payload.delta.text === "string"
        ) {
          yield {
            type: "text-delta",
            textDelta: payload.delta.text
          };
        }

        if (payload.type === "message_delta") {
          finishReason = String(payload.delta?.stop_reason ?? finishReason);
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: Number(payload.usage?.output_tokens ?? usage.outputTokens)
          };
        }
      }

      yield {
        type: "done",
        finishReason,
        usage
      };
    },
    async embed() {
      throw new Error(
        JSON.stringify({
          name: "ModelGatewayError",
          code: "PROVIDER_ERROR",
          provider: "anthropic",
          retriable: false
        })
      );
    },
    async generateImage() {
      throw createUnsupportedModeError("anthropic", "image");
    },
    async synthesizeSpeech() {
      throw createUnsupportedModeError("anthropic", "speech");
    },
    async transcribeAudio() {
      throw createUnsupportedModeError("anthropic", "transcription");
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

async function postFormData(
  config: ProviderConfig,
  path: string,
  body: FormData
): Promise<Response> {
  if (!config.baseUrl) {
    throw new Error("Provider registry error: baseUrl is required.");
  }

  return fetch(buildProviderUrl(config.baseUrl, path), {
    method: "POST",
    headers: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(config.headers ?? {})
    },
    body
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

async function* iterateSsePayloads(response: Response): AsyncIterable<Record<string, any>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const boundary = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (!dataLine) {
        continue;
      }

      const data = dataLine.slice(6).trim();
      if (data === "[DONE]") {
        continue;
      }

      yield JSON.parse(data) as Record<string, any>;
    }
  }
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
  throw new Error(
    JSON.stringify({
      name: "ModelGatewayError",
      code: isRateLimit ? "RATE_LIMITED" : "PROVIDER_ERROR",
      provider,
      retriable: isRateLimit || response.status >= 500,
      statusCode: response.status
    })
  );
}

function createStructuredOutputError(provider: string): Error {
  return new Error(
    JSON.stringify({
      name: "ModelGatewayError",
      code: "SCHEMA_VALIDATION_FAILED",
      provider,
      retriable: false
    })
  );
}

function appendProviderRequestMetadata(
  formData: FormData,
  metadata: Record<string, unknown> | undefined
) {
  if (!metadata) {
    return;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      formData.set(key, String(value));
    }
  }
}

function createUnsupportedModeError(provider: string, mode: SupportedMode): Error {
  return new Error(
    JSON.stringify({
      name: "ModelGatewayError",
      code: "PROVIDER_ERROR",
      provider,
      retriable: false,
      details: {
        mode
      }
    })
  );
}

function readOpenAiChatAssistantText(payload: Record<string, any>): string {
  return String(payload.choices?.[0]?.message?.content ?? "");
}

function readOpenAiChatFinishReason(payload: Record<string, any>): string {
  return String(payload.choices?.[0]?.finish_reason ?? "stop");
}

function readOpenAiChatUsage(payload: Record<string, any>): UsageSummary {
  return {
    inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
    outputTokens: Number(payload.usage?.completion_tokens ?? 0)
  };
}

function readOpenAiChatStreamDelta(payload: Record<string, any>): string | null {
  const delta = payload.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : null;
}

function readOpenAiChatStreamFinishReason(payload: Record<string, any>): string | null {
  const finishReason = payload.choices?.[0]?.finish_reason;
  return typeof finishReason === "string" ? finishReason : null;
}

function readResponsesOutputText(payload: Record<string, any>): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  return String(payload.output?.[0]?.content?.[0]?.text ?? "");
}

function readAnthropicText(payload: Record<string, any>): string {
  const firstTextBlock = Array.isArray(payload.content)
    ? payload.content.find((entry: Record<string, unknown>) => entry.type === "text")
    : null;
  return String(firstTextBlock?.text ?? "");
}

function toAnthropicMessages(messages: Array<{ role: string; content: string }>) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}
