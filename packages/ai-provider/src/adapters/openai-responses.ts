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

      const genTextUsage = payload.usage as Record<string, unknown> | undefined;
      return {
        text: readResponsesOutputText(payload),
        finishReason: "stop",
        usage: {
          inputTokens: Number(genTextUsage?.input_tokens ?? 0),
          outputTokens: Number(genTextUsage?.output_tokens ?? 0),
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
        finishReason: "stop",
        usage: {
          inputTokens: Number(genObjUsage?.input_tokens ?? 0),
          outputTokens: Number(genObjUsage?.output_tokens ?? 0),
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
          yield { type: "text-delta", textDelta: payload.delta as string };
        }

        if (payload.type === "response.completed") {
          const responseObj = payload.response as Record<string, unknown> | undefined;
          const responseUsage = responseObj?.usage as Record<string, unknown> | undefined;
          usage = {
            inputTokens: Number(responseUsage?.input_tokens ?? 0),
            outputTokens: Number(responseUsage?.output_tokens ?? 0),
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
