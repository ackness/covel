import type { LLMMessage, LLMResponse } from "@covel/shared";

export function submittedOutput(output: Record<string, unknown>): LLMResponse {
  return {
    content: null,
    toolCalls: [
      {
        id: "submission",
        name: "submit-output",
        arguments: JSON.stringify(output),
      },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 10 },
  };
}

/** Follow tool IDs through the actual transcript, including reused IDs. */
export function completedBusinessOutput(
  messages: readonly LLMMessage[],
  name: string,
): Record<string, unknown> | undefined {
  const names = new Map<string, string>();
  let latest: Record<string, unknown> | undefined;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    if (
      message.role !== "tool" ||
      !message.toolCallId ||
      names.get(message.toolCallId) !== name ||
      typeof message.content !== "string"
    )
      continue;
    const envelope: unknown = JSON.parse(message.content);
    if (!envelope || typeof envelope !== "object" || "error" in envelope) {
      latest = undefined;
      continue;
    }
    const data = "data" in envelope ? envelope.data : {};
    latest =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
  }
  return latest;
}
