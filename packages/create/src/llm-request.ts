import type { LLMAdapter, LLMMessage, LLMResponse } from "@covel/shared";

interface LlmRequestOptions {
  readonly llm: LLMAdapter;
  readonly messages: readonly LLMMessage[];
  readonly model?: string;
  readonly signal: AbortSignal;
}

export async function requestLlmResponse(
  options: LlmRequestOptions,
): Promise<LLMResponse> {
  if (!options.llm.stream) {
    return options.llm.generate({
      model: options.model,
      messages: options.messages,
      signal: options.signal,
    });
  }

  let content = "";
  let finishReason: LLMResponse["finishReason"] = "stop";
  let reasoningContent = "";

  for await (const event of options.llm.stream({
    model: options.model,
    messages: options.messages,
    signal: options.signal,
  })) {
    if (event.type === "text-delta") {
      content += event.textDelta;
    } else if (event.type === "done") {
      finishReason =
        event.finishReason === "tool_calls" ||
        event.finishReason === "length" ||
        event.finishReason === "error"
          ? event.finishReason
          : "stop";
      reasoningContent = event.reasoningContent ?? "";
    }
  }

  return {
    content: content || null,
    toolCalls: [],
    finishReason,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(reasoningContent ? { reasoningContent } : {}),
  };
}
