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
  readOpenAiChatStreamDelta,
  readOpenAiChatStreamReasoningDelta,
  readOpenAiChatStreamFinishReason,
} from "./http.js";

import type { TextMessage } from "../types.js";

/**
 * Serialize TextMessage[] to OpenAI wire format.
 * Handles assistant messages with tool_calls and tool role messages.
 */
function serializeMessages(
  messages: TextMessage[]
): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content || null,
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
        content: msg.content,
        tool_call_id: msg.toolCallId,
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * OpenAI Chat Completions v1 adapter.
 * Works with any OpenAI-compatible API (DeepSeek, DashScope, etc.).
 */
export function createOpenAiChatAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(params.messages),
        ...params.providerRequestMetadata,
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
      }

      const response = await postJson(config, "/chat/completions", body);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const toolCalls = readOpenAiChatToolCalls(payload);
      return {
        text: readOpenAiChatText(payload),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
        ...(toolCalls ? { toolCalls } : {}),
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(params.messages),
        response_format: { type: "json_object" },
        ...params.providerRequestMetadata,
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

    async *streamText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(params.messages),
        stream: true,
        ...params.providerRequestMetadata,
      });

      // Check HTTP status before parsing SSE — a non-2xx response won't be SSE
      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-chat");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const reasoningDelta = readOpenAiChatStreamReasoningDelta(payload);
        if (reasoningDelta) {
          yield { type: "reasoning-delta", reasoningDelta };
        }

        const delta = readOpenAiChatStreamDelta(payload);
        if (delta) {
          yield { type: "text-delta", textDelta: delta };
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

      yield { type: "done", finishReason, usage };
    },

    async embed(config, params) {
      const response = await postJson(config, "/embeddings", {
        model: params.model,
        input: params.values,
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        embeddings: data.map(
          (entry: { embedding: number[] }) => entry.embedding
        ),
        usage: {
          inputTokens: Number((payload.usage as Record<string, unknown> | undefined)?.prompt_tokens ?? 0),
          outputTokens: 0,
        },
      };
    },

    async generateImage(config, params) {
      const response = await postJson(config, "/images/generations", {
        model: params.model,
        prompt: params.prompt,
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        images: data
          .map((entry: { b64_json?: string; url?: string; revised_prompt?: string; mime_type?: string }) => ({
            mimeType:
              typeof entry.mime_type === "string" ? entry.mime_type : "image/png",
            ...(typeof entry.b64_json === "string"
              ? { dataBase64: entry.b64_json }
              : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          }))
          .filter(
            (entry: { dataBase64?: string; url?: string }) =>
              entry.dataBase64 || entry.url
          ),
        usage: readOpenAiChatUsage(payload),
      };
    },

    async synthesizeSpeech(config, params) {
      const response = await postJson(config, "/audio/speech", {
        model: params.model,
        input: params.text,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...params.providerRequestMetadata,
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
        params.audio.fileName ?? "audio.bin"
      );
      appendProviderMetadata(formData, params.providerRequestMetadata);

      const response = await postFormData(
        config,
        "/audio/transcriptions",
        formData
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
