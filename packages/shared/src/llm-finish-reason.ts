/**
 * Why a generation ended, in one vocabulary for every protocol. The model
 * gateway returns this value and keeps the provider's own word beside it, as
 * the AI SDK does with `unified` and `raw`.
 *
 * - `stop`: the model ended its answer
 * - `length`: the output or context limit cut the answer
 * - `tool_calls`: the model asked for tool calls
 * - `content_filter`: the provider withheld the answer, a refusal included
 * - `error`: the provider reported a failed generation
 * - `other`: a reason no entry of the table below covers
 */
export type LLMFinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";

/** Provider words, lower case with `_`, for each unified reason. */
const UNIFIED: Readonly<Record<string, LLMFinishReason>> = {
  stop: "stop",
  end_turn: "stop",
  stop_sequence: "stop",
  complete: "stop",
  completed: "stop",
  length: "length",
  max_tokens: "length",
  max_output_tokens: "length",
  model_context_window_exceeded: "length",
  tool_calls: "tool_calls",
  tool_call: "tool_calls",
  tool_use: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
  refusal: "content_filter",
  safety: "content_filter",
  recitation: "content_filter",
  blocklist: "content_filter",
  prohibited_content: "content_filter",
  error: "error",
};

/** A reason the provider left out is a normal end. */
export function unifyFinishReason(raw: unknown): LLMFinishReason {
  if (raw === undefined || raw === null || raw === "") return "stop";
  const word = String(raw).trim().toLowerCase().replaceAll("-", "_");
  return Object.hasOwn(UNIFIED, word) ? UNIFIED[word]! : "other";
}
