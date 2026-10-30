import { renderToolError } from "./tool-result-text.js";
import { parseJsonText } from "@covel/tools";
import type { LLMMessage, LLMResponse, LLMToolCall } from "@covel/shared";

type ToolCallResponse = Pick<
  LLMResponse,
  "content" | "toolCalls" | "reasoningContent" | "providerContinuation"
>;

export function buildAssistantToolCallMessage(
  response: ToolCallResponse,
): LLMMessage {
  return {
    role: "assistant",
    ...(response.providerContinuation
      ? { providerContinuation: response.providerContinuation }
      : {}),
    content: response.content ?? "",
    toolCalls: response.toolCalls.map(normalizeAssistantToolCall),
    ...(response.reasoningContent
      ? { reasoningContent: response.reasoningContent }
      : {}),
  };
}

/** Keep history valid JSON without changing what the executor receives. */
export function normalizeAssistantToolCall(call: LLMToolCall): LLMToolCall {
  // Replay the same parsed value the executor sees. Keep an invalid call's
  // original text as a JSON string, paired with its invalid-input result;
  // never invent an empty object that appears to have been executed.
  let value: unknown;
  try {
    value = parseJsonText(call.arguments);
  } catch {
    value = call.arguments;
  }
  return { ...call, arguments: JSON.stringify(value) };
}

export function buildToolResultMessage(args: {
  readonly toolCallId: string;
  readonly content: string;
}): LLMMessage {
  return {
    role: "tool",
    content: args.content,
    toolCallId: args.toolCallId,
  };
}

export function buildPreToolAbortMessage(args: {
  readonly toolCallId: string;
  readonly reason: string | undefined;
}): LLMMessage {
  return buildToolResultMessage({
    toolCallId: args.toolCallId,
    content: renderToolError({
      code: "refused",
      message: `pre-tool-use hook aborted: ${args.reason}`,
    }),
  });
}

export function buildToolExecutionUnavailableMessage(
  toolCallId: string,
): LLMMessage {
  return buildToolResultMessage({
    toolCallId,
    content: renderToolError({
      code: "unavailable",
      message: "Tool execution not available",
    }),
  });
}
