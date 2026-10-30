import { renderToolError, renderToolSuccess } from "./tool-result-text.js";
import type { SkipReason } from "./tool-batch.js";
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

export function buildSuspendedPlaceholderMessage(
  toolCallId: string,
): LLMMessage {
  return buildToolResultMessage({
    toolCallId,
    content: renderToolSuccess({
      model: { summary: "Suspended: waiting for the player's answer." },
    }),
  });
}

export function buildSkippedToolMessage(args: {
  toolCallId: string;
  reason: Exclude<SkipReason, "hook-aborted">;
}): LLMMessage {
  const messages = {
    suspended:
      "Not run: an earlier call in this response suspended the runtime.",
    terminated: "Not run: an earlier tool result ended the run.",
    aborted: "Not run: this tool batch was aborted.",
  };
  return buildToolResultMessage({
    toolCallId: args.toolCallId,
    content: renderToolError({
      code: "cancelled",
      message: messages[args.reason],
    }),
  });
}

export function buildNestedSuspendMessage(toolCallId: string): LLMMessage {
  return buildToolResultMessage({
    toolCallId,
    content: renderToolError({
      code: "unavailable",
      message: "Suspending is not supported inside a sub-agent run.",
      hint: "Continue without asking the player, or finish with what you have.",
    }),
  });
}

export function buildResumedToolMessage(
  toolCallId: string,
  resumeData: unknown,
): LLMMessage {
  return buildToolResultMessage({
    toolCallId,
    // Preserve every field the player submitted, including identifiers and dates.
    content: JSON.stringify({
      summary: "The player answered.",
      data: resumeData,
    }),
  });
}
