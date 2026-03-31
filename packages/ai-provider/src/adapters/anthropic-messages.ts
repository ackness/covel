import type { ModelProviderAdapter } from "./adapter.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  createUnsupportedModeError,
  readAnthropicText,
  toAnthropicMessages,
} from "./http.js";

/**
 * Anthropic Messages v1 adapter.
 * Handles the Anthropic-specific streaming format and message structure.
 */
export function createAnthropicMessagesAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      return {
        text: readAnthropicText(payload),
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0),
        },
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        system: "Respond with JSON only.",
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata,
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
          outputTokens: Number(payload.usage?.output_tokens ?? 0),
        },
      };
    },

    async *streamText(config, params) {
      const response = await postJson(config, "/messages", {
        model: params.model,
        max_tokens: 1024,
        stream: true,
        messages: toAnthropicMessages(params.messages),
        ...params.providerRequestMetadata,
      });

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        if (
          payload.type === "content_block_delta" &&
          payload.delta?.type === "text_delta" &&
          typeof payload.delta.text === "string"
        ) {
          yield { type: "text-delta", textDelta: payload.delta.text };
        }

        if (payload.type === "message_delta") {
          finishReason = String(
            payload.delta?.stop_reason ?? finishReason
          );
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: Number(
              payload.usage?.output_tokens ?? usage.outputTokens
            ),
          };
        }
      }

      yield { type: "done", finishReason, usage };
    },

    async embed() {
      throw createUnsupportedModeError("anthropic", "embed");
    },
    async generateImage() {
      throw createUnsupportedModeError("anthropic", "image");
    },
    async synthesizeSpeech() {
      throw createUnsupportedModeError("anthropic", "speech");
    },
    async transcribeAudio() {
      throw createUnsupportedModeError("anthropic", "transcription");
    },
  };
}
