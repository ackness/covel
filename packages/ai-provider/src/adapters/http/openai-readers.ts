import type { UsageSummary } from "../../types.js";
import {
  normalizeTokenUsage,
  readOptionalTokenCount,
  readTokenCount,
} from "../usage.js";

/** Narrow an unknown value to a plain object, or `undefined` otherwise. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOpenAiUsageDetails(
  value: unknown,
): Pick<UsageSummary, "cachedInputTokens" | "cacheWriteInputTokens"> {
  const details = asRecord(value);
  const cachedInputTokens = readOptionalTokenCount(details?.cached_tokens);
  const cacheWriteInputTokens = readOptionalTokenCount(
    details?.cache_write_tokens,
  );
  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

/** `payload.choices[0]` as an object, or `undefined` if absent/malformed. */
function firstChoice(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const choices = payload.choices;
  return Array.isArray(choices) ? asRecord(choices[0]) : undefined;
}

export function readOpenAiChatText(payload: Record<string, unknown>): string {
  const message = asRecord(firstChoice(payload)?.message);
  return String(message?.content ?? "");
}

export function readOpenAiChatFinishReason(
  payload: Record<string, unknown>,
): string {
  return String(firstChoice(payload)?.finish_reason ?? "stop");
}

export function readOpenAiChatUsage(
  payload: Record<string, unknown>,
): UsageSummary {
  const usage = payload.usage as Record<string, unknown> | undefined;
  return normalizeTokenUsage({
    inputTokens: readTokenCount(usage?.prompt_tokens),
    outputTokens: readTokenCount(usage?.completion_tokens),
    ...readOpenAiUsageDetails(usage?.prompt_tokens_details),
  });
}

export function readOpenAiResponsesUsage(
  payload: Record<string, unknown> | undefined,
): UsageSummary {
  const usage = asRecord(payload?.usage);
  return normalizeTokenUsage({
    inputTokens: readTokenCount(usage?.input_tokens),
    outputTokens: readTokenCount(usage?.output_tokens),
    ...readOpenAiUsageDetails(usage?.input_tokens_details),
  });
}

export function readOpenAiChatStreamDelta(
  payload: Record<string, unknown>,
): string | null {
  const delta = asRecord(firstChoice(payload)?.delta)?.content;
  return typeof delta === "string" ? delta : null;
}

/**
 * Wire field that carried a Chat Completions reasoning trace. DeepSeek and
 * DashScope use `reasoning_content`; groq, OpenRouter and recent vLLM use
 * `reasoning`. A follow-up turn has to echo it under the same field: groq
 * rejects `reasoning_content` on an assistant message.
 */
export type OpenAiChatReasoningField = "reasoning_content" | "reasoning";

export interface OpenAiChatReasoning {
  readonly text: string;
  readonly field: OpenAiChatReasoningField;
}

function readOpenAiChatReasoning(
  record: Record<string, unknown> | undefined,
): OpenAiChatReasoning | null {
  for (const field of ["reasoning_content", "reasoning"] as const) {
    const text = record?.[field];
    if (typeof text === "string" && text.length > 0) return { text, field };
  }
  return null;
}

export function readOpenAiChatStreamReasoningDelta(
  payload: Record<string, unknown>,
): OpenAiChatReasoning | null {
  return readOpenAiChatReasoning(asRecord(firstChoice(payload)?.delta));
}

export function readOpenAiChatReasoningContent(
  payload: Record<string, unknown>,
): OpenAiChatReasoning | null {
  return readOpenAiChatReasoning(asRecord(firstChoice(payload)?.message));
}

export function readOpenAiChatStreamFinishReason(
  payload: Record<string, unknown>,
): string | null {
  const reason = firstChoice(payload)?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

export function readOpenAiChatStreamToolCallDeltas(
  payload: Record<string, unknown>,
): Array<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}> | null {
  const toolCalls = asRecord(firstChoice(payload)?.delta)?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  return toolCalls.map((tc: Record<string, unknown>) => {
    const fn = tc.function as Record<string, unknown> | undefined;
    return {
      index: Number(tc.index ?? 0),
      id: typeof tc.id === "string" ? tc.id : undefined,
      name: typeof fn?.name === "string" ? fn.name : undefined,
      argumentsDelta:
        typeof fn?.arguments === "string" ? fn.arguments : undefined,
    };
  });
}

/**
 * The tool calls of a non-streamed reply. Some compatible gateways leave `id`
 * out; such a call takes `fallbackId` of its position, as the streamed reader
 * gives it.
 */
export function readOpenAiChatToolCalls(
  payload: Record<string, unknown>,
  fallbackId: (index: number) => string,
): Array<{ id: string; name: string; arguments: string }> | null {
  const toolCalls = asRecord(firstChoice(payload)?.message)?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const valid = toolCalls.flatMap((tc: unknown, index) => {
    const entry = asRecord(tc);
    const fn = asRecord(entry?.function);
    if (typeof fn?.name !== "string" || typeof fn.arguments !== "string")
      return [];
    return [
      {
        id:
          typeof entry?.id === "string" && entry.id
            ? entry.id
            : fallbackId(index),
        name: fn.name,
        arguments: fn.arguments,
      },
    ];
  });
  return valid.length === 0 ? null : valid;
}

export function readResponsesOutputText(
  payload: Record<string, unknown>,
): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (Array.isArray(payload.output) ? payload.output : [])
    .map(asRecord)
    .filter((item) => item?.type === "message" || item?.type === undefined)
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map(asRecord)
    .filter(
      (part) =>
        (part?.type === "output_text" || part?.type === undefined) &&
        typeof part?.text === "string",
    )
    .map((part) => part!.text as string)
    .join("");
}

// ── OpenAI Responses API — streaming function calls ─────────────────
//
// The Responses API streams tool calls through semantic events that are
// distinct from Chat Completions' `delta.tool_calls`:
//   - `response.output_item.added` announces a `function_call` item that
//     carries the canonical `call_id`, `name`, and the (empty) `arguments`,
//     keyed by the item `id`.
//   - `response.function_call_arguments.delta` streams the JSON argument
//     string in chunks, keyed by `item_id`.
//   - `response.function_call_arguments.done` carries the final, complete
//     `arguments` string, keyed by `item_id`.

/**
 * Read a `function_call` item announced by `response.output_item.added`.
 * Returns null for any other event or item type.
 */
export function readResponsesStreamFunctionCallAdded(
  payload: Record<string, unknown>,
): {
  id: string;
  callId: string | null;
  name: string | null;
  arguments: string;
} | null {
  if (payload.type !== "response.output_item.added") return null;
  const item = asRecord(payload.item);
  if (!item || item.type !== "function_call") return null;
  const id = typeof item.id === "string" ? item.id : null;
  if (!id) return null;
  return {
    id,
    callId: typeof item.call_id === "string" ? item.call_id : null,
    name: typeof item.name === "string" ? item.name : null,
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  };
}

/**
 * Read an arguments delta from `response.function_call_arguments.delta`.
 * Returns null for any other event or a malformed payload.
 */
export function readResponsesStreamFunctionCallArgsDelta(
  payload: Record<string, unknown>,
): { itemId: string; delta: string } | null {
  if (payload.type !== "response.function_call_arguments.delta") return null;
  if (typeof payload.item_id !== "string" || typeof payload.delta !== "string")
    return null;
  return { itemId: payload.item_id, delta: payload.delta };
}

/**
 * Read the finalized arguments from `response.function_call_arguments.done`.
 * The `arguments` field is authoritative and supersedes accumulated deltas.
 */
export function readResponsesStreamFunctionCallArgsDone(
  payload: Record<string, unknown>,
): { itemId: string; name: string | null; arguments: string } | null {
  if (payload.type !== "response.function_call_arguments.done") return null;
  if (typeof payload.item_id !== "string") return null;
  return {
    itemId: payload.item_id,
    name: typeof payload.name === "string" ? payload.name : null,
    arguments: typeof payload.arguments === "string" ? payload.arguments : "",
  };
}
