/**
 * LLM mock setup + response normalization for the test runtime.
 *
 * Extracted from runner.ts: builds the {@link MockLLM} from debug options,
 * serializes captured calls, and normalizes raw response shapes into the
 * {@link LLMResponse} contract.
 */

import { MockLLM, type MockLLMCall } from "@covel/plugin-test-utils";
import type { LLMResponse } from "@covel/runtime";
import type { RunRuntimeDebugOptions } from "./types.js";

export function buildMockLlm(options: RunRuntimeDebugOptions): MockLLM {
  const responses = normalizeLlmResponses(options);
  return new MockLLM({
    responses,
    // Original DebugLLM stayed on the last response after exhausting the
    // queue; mirror that by using the final response as the fallback.
    defaultResponse: responses[responses.length - 1],
    captureMessages: options.showPrompts === true,
  });
}

export function serializeLlmCalls(
  calls: readonly MockLLMCall[],
  showPrompts: boolean,
): readonly unknown[] {
  return calls.map((call) => ({
    callIndex: call.callIndex,
    model: call.model,
    toolNames: call.toolNames ?? [],
    responseFormat: call.responseFormat,
    ...(showPrompts ? { messages: call.messages } : {}),
  }));
}

function normalizeLlmResponses(
  options: RunRuntimeDebugOptions,
): readonly LLMResponse[] {
  if (options.llmResponses && options.llmResponses.length > 0) {
    return options.llmResponses.map((raw) => normalizeRawLlmResponse(raw));
  }
  return [normalizeLlmResponse(options)];
}

function normalizeLlmResponse(options: RunRuntimeDebugOptions): LLMResponse {
  const raw = options.llmResponse;
  if (raw) {
    return normalizeRawLlmResponse(raw);
  }
  const content = options.llmObject
    ? JSON.stringify(options.llmObject)
    : (options.llmContent ?? '{"ok":true}');
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function normalizeRawLlmResponse(raw: Record<string, unknown>): LLMResponse {
  return {
    content:
      typeof raw.content === "string" || raw.content === null
        ? raw.content
        : "",
    toolCalls: Array.isArray(raw.toolCalls)
      ? (raw.toolCalls as LLMResponse["toolCalls"])
      : [],
    finishReason:
      raw.finishReason === "tool_calls" ||
      raw.finishReason === "length" ||
      raw.finishReason === "error"
        ? raw.finishReason
        : "stop",
    usage: isUsage(raw.usage) ? raw.usage : { inputTokens: 1, outputTokens: 1 },
  };
}

function isUsage(
  value: unknown,
): value is { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== "object") return false;
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
  return (
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
  );
}
