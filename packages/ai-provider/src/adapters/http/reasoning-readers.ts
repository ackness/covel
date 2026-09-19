/** Only provider-exposed text is displayable; signatures and encrypted state are not. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readAnthropicReasoning(
  payload: Record<string, unknown>,
): string | undefined {
  const text = (Array.isArray(payload.content) ? payload.content : [])
    .map(record)
    .filter(
      (block) =>
        block.type === "thinking" && typeof block.thinking === "string",
    )
    .map((block) => block.thinking as string)
    .filter((text) => text.trim())
    .join("\n\n");
  return text || undefined;
}

export function readResponsesReasoning(
  payload: Record<string, unknown>,
): string | undefined {
  const text = (Array.isArray(payload.output) ? payload.output : [])
    .map(record)
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => (Array.isArray(item.summary) ? item.summary : []))
    .map(record)
    .filter(
      (part) => part.type === "summary_text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .filter((text) => text.trim())
    .join("\n\n");
  return text || undefined;
}

/** Full summary events replace deltas, preventing duplicate text at completion. */
export class ResponsesReasoningAccumulator {
  private readonly parts = new Map<
    string,
    { output: number; summary: number; text: string }
  >();
  private completed?: string;

  push(payload: Record<string, unknown>): string | undefined {
    const isDelta = payload.type === "response.reasoning_summary_text.delta";
    const isDone = payload.type === "response.reasoning_summary_text.done";
    if (isDelta || isDone) {
      const text = isDelta ? payload.delta : payload.text;
      if (typeof text !== "string") return undefined;
      const output = Number(payload.output_index ?? 0);
      const summary = Number(payload.summary_index ?? 0);
      const key = `${payload.item_id ?? output}:${summary}`;
      const previous = this.parts.get(key)?.text ?? "";
      this.parts.set(key, {
        output,
        summary,
        text: isDelta ? previous + text : text,
      });
      return isDelta ? text : undefined;
    }
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(
        String(payload.type),
      )
    ) {
      this.completed = readResponsesReasoning(record(payload.response));
    }
    return undefined;
  }

  text(): string | undefined {
    return (
      this.completed ??
      ([...this.parts.values()]
        .sort((a, b) => a.output - b.output || a.summary - b.summary)
        .map((part) => part.text)
        .filter((text) => text.trim())
        .join("\n\n") ||
        undefined)
    );
  }
}
