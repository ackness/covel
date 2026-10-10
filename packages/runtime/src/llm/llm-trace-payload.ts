import { compactProviderRequests } from "@covel/shared";
import type {
  LLMProviderRequest,
  LLMResponseFormat,
  LLMRequestDefaults,
} from "@covel/shared";
/**
 * Shared builders for `llm.calling` / `llm.responded` trace payloads.
 *
 * Centralising these shapes prevents schema drift across the 4 emit sites
 * (retry helper sync, retry helper streaming, direct generate resume path,
 * direct generate malformed-tool-args fallback).
 *
 * Payload fields map 1:1 to the debug trace event schemas documented in
 * `docs/reference/protocol.md`.
 */

import type {
  LLMMessage,
  LLMResponse,
  LLMToolDefinition,
} from "./llm-adapter.js";

export interface LlmCallingPayloadInput {
  readonly providerRequests?: readonly LLMProviderRequest[];
  readonly responseFormat?: LLMResponseFormat;
  readonly defaults?: LLMRequestDefaults;
  readonly maxOutputTokens?: number;
  readonly runtimeId: string | undefined;
  readonly pluginId: string | undefined;
  readonly slot: string | undefined;
  readonly model: string | undefined;
  /**
   * Provider identity resolved from the requested slot. `undefined` is kept
   * for lightweight adapters that do not expose slot resolution.
   */
  readonly provider: string | undefined;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMToolDefinition[] | undefined;
  readonly attempt: number;
  /** Actual provider request start, independent of trace persistence time. */
  readonly startedAt: string;
  readonly streaming?: boolean;
  /** Measured wait for the framework concurrency slot, before provider timing. */
  readonly queueWaitMs?: number;
}

/**
 * Messages as a trace keeps them: the base64 body of an image is megabytes
 * and is replaced by its size. The provider request of the same event shows
 * the part in its wire shape.
 */
function traceMessages(messages: readonly LLMMessage[]): readonly unknown[] {
  return messages.map((message) =>
    // A replayed tool-call message can hold `null` content.
    !Array.isArray(message.content) ||
    !message.content.some((part) => part.type === "image")
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === "image" && !/^https?:\/\//i.test(part.image)
              ? {
                  ...part,
                  image: `[image data omitted: ${part.image.length} base64 characters]`,
                }
              : part,
          ),
        },
  );
}

export function buildLlmCallingPayload(
  input: LlmCallingPayloadInput,
): Record<string, unknown> {
  return {
    ...(input.providerRequests?.length
      ? { providerRequests: compactProviderRequests(input.providerRequests) }
      : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    ...(input.maxOutputTokens !== undefined
      ? { maxOutputTokens: input.maxOutputTokens }
      : {}),
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    slot: input.slot,
    model: input.model,
    provider: input.provider,
    messages: traceMessages(input.messages),
    tools: (input.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: t.parameters,
    })),
    attempt: input.attempt,
    startedAt: input.startedAt,
    ...(input.queueWaitMs !== undefined
      ? { queueWaitMs: input.queueWaitMs }
      : {}),
    ...(input.streaming ? { streaming: true } : {}),
  };
}

export interface LlmRespondedSuccessInput {
  readonly runtimeId: string | undefined;
  readonly pluginId: string | undefined;
  readonly response: LLMResponse;
  readonly durationMs: number;
  readonly attempt: number;
  readonly streaming?: boolean;
}

export function buildLlmRespondedSuccessPayload(
  input: LlmRespondedSuccessInput,
): Record<string, unknown> {
  return {
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    text: input.response.content ?? "",
    ...(input.response.diagnostics
      ? { diagnostics: input.response.diagnostics }
      : {}),
    ...(input.response.reasoningContent
      ? { reasoningContent: input.response.reasoningContent }
      : {}),
    toolCalls: input.response.toolCalls,
    usage: input.response.usage,
    finishReason: input.response.finishReason,
    durationMs: input.durationMs,
    attempt: input.attempt,
    ...(input.streaming ? { streaming: true } : {}),
  };
}

export interface LlmRespondedErrorInput {
  readonly runtimeId: string | undefined;
  readonly pluginId: string | undefined;
  readonly error: unknown;
  /** Usage the provider reported before the response was rejected. */
  readonly usage?: LLMResponse["usage"];
  readonly durationMs: number;
  readonly attempt: number;
  readonly streaming?: boolean;
}

export function buildLlmRespondedErrorPayload(
  input: LlmRespondedErrorInput,
): Record<string, unknown> {
  const error = input.error;
  const details =
    error && typeof error === "object" && "details" in error
      ? error.details
      : undefined;
  const diagnostics =
    details && typeof details === "object" && "diagnostics" in details
      ? details.diagnostics
      : undefined;
  const errorUsage =
    details && typeof details === "object" && "usage" in details
      ? (details.usage as LLMResponse["usage"])
      : undefined;
  return {
    ...(diagnostics ? { diagnostics } : {}),
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    finishReason: "error",
    error:
      input.error instanceof Error ? input.error.message : String(input.error),
    usage: input.usage ?? errorUsage ?? { inputTokens: 0, outputTokens: 0 },
    durationMs: input.durationMs,
    attempt: input.attempt,
    ...(input.streaming ? { streaming: true } : {}),
  };
}

// Re-export types the builders reference so call sites can import from a
// single module.
export type { LLMMessage, LLMResponse, LLMToolDefinition };
