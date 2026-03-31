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
  readOpenAiChatStreamDelta,
  readOpenAiChatStreamFinishReason,
} from "./http.js";

/**
 * OpenAI Chat Completions v1 adapter.
 * Works with any OpenAI-compatible API (DeepSeek, DashScope, etc.).
 */
export function createOpenAiChatAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      return {
        text: readOpenAiChatText(payload),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: params.messages,
        response_format: { type: "json_object" },
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const rawObject = JSON.parse(readOpenAiChatText(payload));
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
        messages: params.messages,
        stream: true,
        ...params.providerRequestMetadata,
      });

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const delta = readOpenAiChatStreamDelta(payload);
        if (delta) {
          yield { type: "text-delta", textDelta: delta };
        }

        if (payload.usage && typeof payload.usage === "object") {
          usage = {
            inputTokens: Number(payload.usage.prompt_tokens ?? 0),
            outputTokens: Number(payload.usage.completion_tokens ?? 0),
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
          inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
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
          .map((entry: any) => ({
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

      return {
        text: String(payload.text ?? ""),
        usage:
          payload.usage && typeof payload.usage === "object"
            ? {
                inputTokens: Number(payload.usage.prompt_tokens ?? 0),
                outputTokens: Number(payload.usage.completion_tokens ?? 0),
              }
            : null,
      };
    },
  };
}
