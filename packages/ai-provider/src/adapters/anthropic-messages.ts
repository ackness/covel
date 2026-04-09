/** Appended to system prompt for Anthropic generateObject (no native JSON mode). */
const ANTHROPIC_JSON_DIRECTIVE = "Respond with JSON only.";

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

const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = "2023-06-01";

/** Fields that providerRequestMetadata must never override. */
const ANTHROPIC_PROTECTED_KEYS = new Set(["model", "messages", "stream", "max_tokens", "system"]);

function sanitizeAnthropicMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ANTHROPIC_PROTECTED_KEYS.has(k)) sanitized[k] = v;
  }
  return sanitized;
}

function anthropicHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

function readAnthropicUsage(payload: Record<string, unknown>): UsageSummary {
  const usage = payload.usage as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(usage?.input_tokens ?? 0),
    outputTokens: Number(usage?.output_tokens ?? 0),
  };
}

/**
 * Anthropic Messages v1 adapter.
 * Handles the Anthropic-specific streaming format and message structure.
 */
export function createAnthropicMessagesAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const { system, messages } = toAnthropicMessages(params.messages);
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(configNoKey, "/messages", {
        model: params.model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
        ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
      }, undefined, headers);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      return {
        text: readAnthropicText(payload),
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: readAnthropicUsage(payload),
      };
    },

    async generateObject(config, params) {
      const { system, messages } = toAnthropicMessages(params.messages);
      const systemPrompt = [system, ANTHROPIC_JSON_DIRECTIVE].filter(Boolean).join("\n\n");
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(configNoKey, "/messages", {
        model: params.model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages,
        ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
      }, undefined, headers);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readAnthropicText(payload));
      } catch {
        throw createStructuredOutputError("anthropic");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("anthropic");
      }

      return {
        object: validation.data,
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: readAnthropicUsage(payload),
      };
    },

    async *streamText(config, params) {
      const { system, messages } = toAnthropicMessages(params.messages);
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(configNoKey, "/messages", {
        model: params.model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        stream: true,
        ...(system ? { system } : {}),
        messages,
        ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
      }, undefined, headers);

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "anthropic-messages");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (
          payload.type === "content_block_delta" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          yield { type: "text-delta", textDelta: delta.text };
        }

        if (payload.type === "message_start") {
          const msgUsage = (payload.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
          if (msgUsage) {
            usage = {
              inputTokens: Number(msgUsage.input_tokens ?? 0),
              outputTokens: usage.outputTokens,
            };
          }
        }

        if (payload.type === "message_delta") {
          finishReason = String(
            delta?.stop_reason ?? finishReason
          );
          const usageObj = payload.usage as Record<string, unknown> | undefined;
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: Number(
              usageObj?.output_tokens ?? usage.outputTokens
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
