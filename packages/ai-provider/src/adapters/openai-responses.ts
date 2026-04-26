import type { ModelProviderAdapter } from "./adapter.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  readResponsesOutputText,
} from "./http.js";
import { createOpenAiChatAdapter } from "./openai-chat.js";
import type { ImagePart, TextMessage, TextMessageContent } from "../types.js";

/** Fields that providerRequestMetadata must never override. */
const RESPONSES_PROTECTED_KEYS = new Set(["model", "input", "stream", "text", "parameterOverrides"]);

function sanitizeResponsesMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!RESPONSES_PROTECTED_KEYS.has(k)) sanitized[k] = v;
  }
  return sanitized;
}

function extractResponsesParameterOverrides(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const overrides = meta?.parameterOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  const source = overrides as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof source.temperature === "number") result.temperature = source.temperature;
  if (typeof source.topP === "number") result.top_p = source.topP;
  if (typeof source.maxOutputTokens === "number") {
    result.max_output_tokens = source.maxOutputTokens;
  }
  return result;
}

/**
 * Map OpenAI Responses API `status` field to a finish reason string.
 * The Responses API uses: "completed", "failed", "incomplete", "in_progress".
 */
function mapResponseStatus(status: unknown): string {
  switch (status) {
    case "completed": return "stop";
    case "incomplete": return "length";
    case "failed": return "error";
    default: return "stop";
  }
}

function mediaRefFallbackText(part: ImagePart): string {
  return JSON.stringify({
    type: "image_ref",
    ref: part.image,
    note: "MediaRef has no resolved URL; provider vision input requires a retrievable image URL.",
  });
}

function serializeResponsesContent(content: TextMessageContent): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.image.url) return { type: "input_image", image_url: part.image.url };
    return { type: "input_text", text: mediaRefFallbackText(part) };
  });
}

function serializeResponsesInput(messages: TextMessage[]): unknown {
  return messages.map((msg) => ({
    role: msg.role,
    content: serializeResponsesContent(msg.content),
  }));
}

/**
 * OpenAI Responses v1 adapter.
 * Uses the /responses endpoint with different streaming format.
 * Falls back to OpenAI Chat adapter for non-text operations.
 */
export function createOpenAiResponsesAdapter(): ModelProviderAdapter {
  const chatAdapter = createOpenAiChatAdapter();

  return {
    async generateText(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: serializeResponsesInput(params.messages),
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      const genTextUsage = payload.usage as Record<string, unknown> | undefined;
      return {
        text: readResponsesOutputText(payload),
        finishReason: mapResponseStatus(payload.status),
        usage: {
          inputTokens: Number(genTextUsage?.input_tokens ?? 0),
          outputTokens: Number(genTextUsage?.output_tokens ?? 0),
        },
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: serializeResponsesInput(params.messages),
        text: { format: { type: "json_schema" } },
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readResponsesOutputText(payload));
      } catch {
        throw createStructuredOutputError("openai-responses");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-responses");
      }

      const genObjUsage = payload.usage as Record<string, unknown> | undefined;
      return {
        object: validation.data,
        finishReason: mapResponseStatus(payload.status),
        usage: {
          inputTokens: Number(genObjUsage?.input_tokens ?? 0),
          outputTokens: Number(genObjUsage?.output_tokens ?? 0),
        },
      };
    },

    async *streamText(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: serializeResponsesInput(params.messages),
        stream: true,
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(params.providerRequestMetadata),
      });

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-responses");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let streamFinishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        if (
          payload.type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        ) {
          yield { type: "text-delta", textDelta: payload.delta as string };
        }

        if (payload.type === "response.completed") {
          const responseObj = payload.response as Record<string, unknown> | undefined;
          const responseUsage = responseObj?.usage as Record<string, unknown> | undefined;
          usage = {
            inputTokens: Number(responseUsage?.input_tokens ?? 0),
            outputTokens: Number(responseUsage?.output_tokens ?? 0),
          };
          streamFinishReason = mapResponseStatus(responseObj?.status);
        }
      }

      yield { type: "done", finishReason: streamFinishReason, usage };
    },

    // Delegate non-text operations to the chat adapter
    embed: (config, params, context) =>
      chatAdapter.embed(config, params, context),
    synthesizeSpeech: (config, params, context) =>
      chatAdapter.synthesizeSpeech(config, params, context),
    transcribeAudio: (config, params, context) =>
      chatAdapter.transcribeAudio(config, params, context),
  };
}
