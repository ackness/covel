/**
 * Shared builders for `llm.calling` / `llm.responded` trace payloads.
 *
 * Centralising these shapes prevents schema drift across the 4 emit sites
 * (retry helper sync, retry helper streaming, direct generate resume path,
 * direct generate malformed-tool-args fallback).
 *
 * Payload fields map 1:1 to the schemas documented in
 * `docs/superpowers/specs/2026-04-22-debug-trace-expansion-design.md`.
 */

import type {
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  LLMToolDefinition,
} from './llm-adapter.js';

export interface LlmCallingPayloadInput {
  readonly runtimeId: string | undefined;
  readonly pluginId: string | undefined;
  readonly slot: string | undefined;
  readonly model: string | undefined;
  /**
   * Provider identity. `undefined` from retry-helper sites that haven't been
   * wired with provider detection yet; `null` from direct-generate sites that
   * bypass the helper and therefore can't know the provider. JSON-serialising
   * `undefined` drops the key — callers that want stable key presence emit
   * `null` explicitly.
   */
  readonly provider: string | undefined | null;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMToolDefinition[] | undefined;
  readonly attempt: number;
  readonly streaming?: boolean;
}

export function buildLlmCallingPayload(input: LlmCallingPayloadInput): Record<string, unknown> {
  return {
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    slot: input.slot,
    model: input.model,
    provider: input.provider,
    messages: input.messages,
    tools: (input.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: t.parameters,
    })),
    attempt: input.attempt,
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
    text: input.response.content ?? '',
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
  readonly durationMs: number;
  readonly attempt: number;
  readonly streaming?: boolean;
}

export function buildLlmRespondedErrorPayload(
  input: LlmRespondedErrorInput,
): Record<string, unknown> {
  return {
    runtimeId: input.runtimeId,
    pluginId: input.pluginId,
    finishReason: 'error',
    error: input.error instanceof Error ? input.error.message : String(input.error),
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: input.durationMs,
    attempt: input.attempt,
    ...(input.streaming ? { streaming: true } : {}),
  };
}

// Re-export types the builders reference so call sites can import from a
// single module.
export type { LLMMessage, LLMResponse, LLMToolCall, LLMToolDefinition };
