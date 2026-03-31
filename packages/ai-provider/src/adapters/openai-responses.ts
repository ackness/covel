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
        input: params.messages,
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      return {
        text: readResponsesOutputText(payload),
        finishReason: "stop",
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0),
        },
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: params.messages,
        text: { format: { type: "json_schema" } },
        ...params.providerRequestMetadata,
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      const rawObject = JSON.parse(readResponsesOutputText(payload));
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-responses");
      }

      return {
        object: validation.data,
        finishReason: "stop",
        usage: {
          inputTokens: Number(payload.usage?.input_tokens ?? 0),
          outputTokens: Number(payload.usage?.output_tokens ?? 0),
        },
      };
    },

    async *streamText(config, params) {
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: params.messages,
        stream: true,
        ...params.providerRequestMetadata,
      });

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };

      for await (const payload of iterateSsePayloads(response)) {
        if (
          payload.type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        ) {
          yield { type: "text-delta", textDelta: payload.delta };
        }

        if (payload.type === "response.completed") {
          usage = {
            inputTokens: Number(
              payload.response?.usage?.input_tokens ?? 0
            ),
            outputTokens: Number(
              payload.response?.usage?.output_tokens ?? 0
            ),
          };
        }
      }

      yield { type: "done", finishReason: "stop", usage };
    },

    // Delegate non-text operations to the chat adapter
    embed: (config, params, context) =>
      chatAdapter.embed(config, params, context),
    generateImage: (config, params, context) =>
      chatAdapter.generateImage(config, params, context),
    synthesizeSpeech: (config, params, context) =>
      chatAdapter.synthesizeSpeech(config, params, context),
    transcribeAudio: (config, params, context) =>
      chatAdapter.transcribeAudio(config, params, context),
  };
}
