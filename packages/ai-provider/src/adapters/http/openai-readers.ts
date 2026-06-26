import type { UsageSummary } from "../../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asAny(value: unknown): any {
  return value;
}

export function readOpenAiChatText(payload: Record<string, unknown>): string {
  return String(asAny(payload).choices?.[0]?.message?.content ?? "");
}

export function readOpenAiChatFinishReason(
  payload: Record<string, unknown>,
): string {
  return String(asAny(payload).choices?.[0]?.finish_reason ?? "stop");
}

export function readOpenAiChatUsage(
  payload: Record<string, unknown>,
): UsageSummary {
  const usage = payload.usage as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(usage?.prompt_tokens ?? 0),
    outputTokens: Number(usage?.completion_tokens ?? 0),
  };
}

export function readOpenAiChatStreamDelta(
  payload: Record<string, unknown>,
): string | null {
  const delta = asAny(payload).choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : null;
}

export function readOpenAiChatStreamReasoningDelta(
  payload: Record<string, unknown>,
): string | null {
  const delta = asAny(payload).choices?.[0]?.delta?.reasoning_content;
  return typeof delta === "string" && delta.length > 0 ? delta : null;
}

export function readOpenAiChatReasoningContent(
  payload: Record<string, unknown>,
): string | null {
  const reasoning = asAny(payload).choices?.[0]?.message?.reasoning_content;
  return typeof reasoning === "string" && reasoning.length > 0
    ? reasoning
    : null;
}

export function readOpenAiChatStreamFinishReason(
  payload: Record<string, unknown>,
): string | null {
  const reason = asAny(payload).choices?.[0]?.finish_reason;
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
  const toolCalls = asAny(payload).choices?.[0]?.delta?.tool_calls;
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

export function readOpenAiChatToolCalls(
  payload: Record<string, unknown>,
): Array<{ id: string; name: string; arguments: string }> | null {
  const toolCalls = asAny(payload).choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const valid = toolCalls.filter(
    (
      tc: unknown,
    ): tc is { id: string; function: { name: string; arguments: string } } => {
      const entry = tc as Record<string, unknown> | null | undefined;
      return (
        typeof entry?.id === "string" &&
        typeof (entry?.function as Record<string, unknown> | undefined)
          ?.name === "string" &&
        typeof (entry?.function as Record<string, unknown> | undefined)
          ?.arguments === "string"
      );
    },
  );
  if (valid.length === 0) return null;
  return valid.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

export function readResponsesOutputText(
  payload: Record<string, unknown>,
): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  return String(asAny(payload).output?.[0]?.content?.[0]?.text ?? "");
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
  const item = asAny(payload).item;
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
  const p = asAny(payload);
  if (typeof p.item_id !== "string" || typeof p.delta !== "string") return null;
  return { itemId: p.item_id, delta: p.delta };
}

/**
 * Read the finalized arguments from `response.function_call_arguments.done`.
 * The `arguments` field is authoritative and supersedes accumulated deltas.
 */
export function readResponsesStreamFunctionCallArgsDone(
  payload: Record<string, unknown>,
): { itemId: string; name: string | null; arguments: string } | null {
  if (payload.type !== "response.function_call_arguments.done") return null;
  const p = asAny(payload);
  if (typeof p.item_id !== "string") return null;
  return {
    itemId: p.item_id,
    name: typeof p.name === "string" ? p.name : null,
    arguments: typeof p.arguments === "string" ? p.arguments : "",
  };
}
