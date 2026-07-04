import type { TextMessage, TextMessageContent } from "../../types.js";
import { mediaRefFallbackText } from "../common.js";

export function readAnthropicText(payload: Record<string, unknown>): string {
  const block = Array.isArray(payload.content)
    ? payload.content.find(
        (entry: Record<string, unknown>) => entry.type === "text",
      )
    : null;
  return String(block?.text ?? "");
}

let toolDropWarned = false;

export function toAnthropicMessages(messages: TextMessage[]): {
  system: string;
  messages: Array<{ role: string; content: string | readonly unknown[] }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => anthropicSystemText(m.content))
    .filter(Boolean)
    .join("\n\n");
  const toolMessages = messages.filter((m) => m.role === "tool");
  if (toolMessages.length > 0 && !toolDropWarned) {
    toolDropWarned = true;
    console.warn(
      `[anthropic] Dropped ${toolMessages.length} tool-role message(s) (not supported in this adapter path). This warning is shown once.`,
    );
  }
  const filtered = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: serializeAnthropicContent(m.content),
    }));
  return { system, messages: filtered };
}

function anthropicSystemText(content: TextMessageContent): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  return content
    .map((part) =>
      part.type === "text" ? part.text : mediaRefFallbackText(part),
    )
    .filter(Boolean)
    .join("\n\n");
}

function serializeAnthropicContent(
  content: TextMessageContent,
): string | readonly unknown[] {
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.image.url) {
      return { type: "image", source: { type: "url", url: part.image.url } };
    }
    return { type: "text", text: mediaRefFallbackText(part) };
  });
}
