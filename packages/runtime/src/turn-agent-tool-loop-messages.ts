import type { LLMMessage, LLMResponse } from "./llm-adapter.js";

type ToolCallResponse = Pick<
  LLMResponse,
  "content" | "toolCalls" | "reasoningContent"
>;

export function buildAssistantToolCallMessage(
  response: ToolCallResponse,
): LLMMessage {
  return {
    role: "assistant",
    content: response.content ?? "",
    toolCalls: response.toolCalls,
    ...(response.reasoningContent
      ? { reasoningContent: response.reasoningContent }
      : {}),
  };
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
    content: JSON.stringify({
      error: `pre-tool-use hook aborted: ${args.reason}`,
    }),
  });
}

export function buildToolExecutionUnavailableMessage(
  toolCallId: string,
): LLMMessage {
  return buildToolResultMessage({
    toolCallId,
    content: JSON.stringify({
      result: "Tool execution not available",
    }),
  });
}
