import type { ModelProviderAdapter } from "./adapter.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  postFormData,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  appendProviderMetadata,
  readOpenAiChatText,
  readOpenAiChatFinishReason,
  readOpenAiChatUsage,
  readOpenAiChatToolCalls,
  readOpenAiChatReasoningContent,
  readOpenAiChatStreamDelta,
  readOpenAiChatStreamReasoningDelta,
  readOpenAiChatStreamFinishReason,
  readOpenAiChatStreamToolCallDeltas,
} from "./http.js";
import { applyCapabilityFallback } from "./capability-fallback.js";

import type { ImagePart, TextMessage, TextMessageContent } from "../types.js";

/** Fields that providerRequestMetadata must never override. */
const OPENAI_PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "response_format",
  // `input` is protected for embeddings — it is built from params.values.
  "input",
  // Slot-level dispatch hints — consumed by the adapter, not forwarded.
  "embeddingFormat",
  // Slot-level generation params — translated by the adapter.
  "parameterOverrides",
]);

function sanitizeOpenAiMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!OPENAI_PROTECTED_KEYS.has(k)) sanitized[k] = v;
  }
  return sanitized;
}

function extractOpenAiParameterOverrides(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const overrides = meta?.parameterOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  const source = overrides as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof source.temperature === "number")
    result.temperature = source.temperature;
  if (typeof source.topP === "number") result.top_p = source.topP;
  if (typeof source.maxOutputTokens === "number")
    result.max_tokens = source.maxOutputTokens;
  if (typeof source.frequencyPenalty === "number") {
    result.frequency_penalty = source.frequencyPenalty;
  }
  if (typeof source.presencePenalty === "number") {
    result.presence_penalty = source.presencePenalty;
  }
  return result;
}

/**
 * Build the `input` field for a POST /embeddings request, dispatching on
 * the slot's declared embedding format.
 *
 * - "openai" (default): array of strings, per the OpenAI spec.
 * - "nemotron-multimodal": OpenRouter NVIDIA Nemotron multimodal shape
 *   where each element is `{content: [{type: "text", text}, ...]}`. Phase 1
 *   supports text parts only; adding image_url parts is a Phase 2 feature.
 */
function buildEmbeddingInput(values: string[], format: string): unknown {
  if (format === "nemotron-multimodal") {
    return values.map((text) => ({
      content: [{ type: "text", text }],
    }));
  }
  return values;
}

function mediaRefFallbackText(part: ImagePart): string {
  return JSON.stringify({
    type: "image_ref",
    ref: part.image,
    note: "MediaRef has no resolved URL; provider vision input requires a retrievable image URL.",
  });
}

function serializeOpenAiChatContent(content: TextMessageContent): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.image.url) {
      return { type: "image_url", image_url: { url: part.image.url } };
    }
    return { type: "text", text: mediaRefFallbackText(part) };
  });
}

/**
 * Serialize TextMessage[] to OpenAI wire format.
 * Handles assistant messages with tool_calls and tool role messages.
 */
function serializeMessages(messages: TextMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: serializeOpenAiChatContent(msg.content) || null,
        ...(msg.reasoningContent
          ? { reasoning_content: msg.reasoningContent }
          : {}),
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (msg.role === "tool" && msg.toolCallId) {
      return {
        role: "tool",
        content: serializeOpenAiChatContent(msg.content),
        tool_call_id: msg.toolCallId,
      };
    }
    if (msg.role === "assistant" && msg.reasoningContent) {
      return {
        role: "assistant",
        content: serializeOpenAiChatContent(msg.content),
        reasoning_content: msg.reasoningContent,
      };
    }
    return { role: msg.role, content: serializeOpenAiChatContent(msg.content) };
  });
}

/**
 * OpenAI Chat Completions v1 adapter.
 * Works with any OpenAI-compatible API (DeepSeek, DashScope, etc.).
 */
export function createOpenAiChatAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(messages),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(params.providerRequestMetadata),
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
        body.tool_choice = "auto";
      }

      const response = await postJson(config, "/chat/completions", body);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const toolCalls = readOpenAiChatToolCalls(payload);
      const reasoningContent = readOpenAiChatReasoningContent(payload);
      return {
        text: readOpenAiChatText(payload),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
        ...(toolCalls ? { toolCalls } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
      };
    },

    async generateObject(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(messages),
        response_format: { type: "json_object" },
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readOpenAiChatText(payload));
      } catch {
        throw createStructuredOutputError("openai-chat");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-chat");
      }

      return {
        object: validation.data,
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
      };
    },

    async *streamText(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(messages),
        stream: true,
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(params.providerRequestMetadata),
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
        body.tool_choice = "auto";
      }
      const response = await postJson(config, "/chat/completions", body);

      // Check HTTP status before parsing SSE — a non-2xx response won't be SSE
      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-chat");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";
      let reasoningAcc = "";
      // Accumulate tool_call deltas by index across chunks.
      const toolCallAcc = new Map<
        number,
        { id: string | null; name: string | null; arguments: string }
      >();

      for await (const payload of iterateSsePayloads(response)) {
        const reasoningDelta = readOpenAiChatStreamReasoningDelta(payload);
        if (reasoningDelta) {
          reasoningAcc += reasoningDelta;
          yield { type: "reasoning-delta", reasoningDelta };
        }

        const delta = readOpenAiChatStreamDelta(payload);
        if (delta) {
          yield { type: "text-delta", textDelta: delta };
        }

        const toolCallDeltas = readOpenAiChatStreamToolCallDeltas(payload);
        if (toolCallDeltas) {
          for (const tcd of toolCallDeltas) {
            const existing = toolCallAcc.get(tcd.index) ?? {
              id: null,
              name: null,
              arguments: "",
            };
            if (tcd.id) existing.id = tcd.id;
            if (tcd.name) existing.name = tcd.name;
            if (tcd.argumentsDelta) existing.arguments += tcd.argumentsDelta;
            toolCallAcc.set(tcd.index, existing);
          }
        }

        if (payload.usage && typeof payload.usage === "object") {
          const usageObj = payload.usage as Record<string, unknown>;
          usage = {
            inputTokens: Number(usageObj.prompt_tokens ?? 0),
            outputTokens: Number(usageObj.completion_tokens ?? 0),
          };
        }

        const reason = readOpenAiChatStreamFinishReason(payload);
        if (reason) finishReason = reason;
      }

      // Emit accumulated tool calls before done.
      if (toolCallAcc.size > 0) {
        const sorted = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, tc] of sorted) {
          if (!tc.id || !tc.name) continue;
          yield {
            type: "tool-call",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments || "{}",
          };
        }
      }

      yield {
        type: "done",
        finishReason,
        usage,
        ...(reasoningAcc ? { reasoningContent: reasoningAcc } : {}),
      };
    },

    async embed(config, params) {
      // Slot-level `embeddingFormat` (from llm.toml) is propagated here via
      // params.providerRequestMetadata.embeddingFormat. Default is the
      // standard OpenAI `input: string[]` shape. Custom formats wrap values
      // into provider-specific content shapes — mirrors the imageApi
      // dispatch pattern further below.
      const meta = params.providerRequestMetadata ?? {};
      const embeddingFormat =
        (meta.embeddingFormat as string | undefined) ?? "openai";

      const input = buildEmbeddingInput(params.values, embeddingFormat);

      const response = await postJson(config, "/embeddings", {
        model: params.model,
        input,
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        embeddings: data.map(
          (entry: { embedding: number[] }) => entry.embedding,
        ),
        usage: {
          inputTokens: Number(
            (payload.usage as Record<string, unknown> | undefined)
              ?.prompt_tokens ?? 0,
          ),
          outputTokens: 0,
        },
      };
    },

    async synthesizeSpeech(config, params) {
      const response = await postJson(config, "/audio/speech", {
        model: params.model,
        input: params.text,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-chat");
      }

      return {
        audio: {
          mimeType: response.headers.get("content-type") ?? "audio/mpeg",
          data: new Uint8Array(await response.arrayBuffer()),
        },
        usage: null,
      };
    },

    async transcribeAudio(config, params) {
      const formData = new FormData();
      formData.set("model", params.model);
      formData.set(
        "file",
        new Blob([params.audio.data.buffer as ArrayBuffer], {
          type: params.audio.mimeType,
        }),
        params.audio.fileName ?? "audio.bin",
      );
      appendProviderMetadata(formData, params.providerRequestMetadata);

      const response = await postFormData(
        config,
        "/audio/transcriptions",
        formData,
      );
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const transcriptionUsage =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : null;
      return {
        text: String(payload.text ?? ""),
        usage: transcriptionUsage
          ? {
              inputTokens: Number(transcriptionUsage.prompt_tokens ?? 0),
              outputTokens: Number(transcriptionUsage.completion_tokens ?? 0),
            }
          : null,
      };
    },
  };
}
