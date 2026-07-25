import type {
  TextMessage,
  TextMessageContent,
  ToolCallPart,
  ToolDefinition,
} from "../../types.js";
import { mediaRefFallbackText } from "../common.js";

export function readAnthropicText(payload: Record<string, unknown>): string {
  const block = Array.isArray(payload.content)
    ? payload.content.find(
        (entry: Record<string, unknown>) => entry.type === "text",
      )
    : null;
  return String(block?.text ?? "");
}

/**
 * OpenAI-shaped `ToolDefinition[]` → Anthropic's `tools` array.
 *
 * The kernel speaks the OpenAI function-calling shape everywhere; only the
 * wire differs (`function.parameters` → `input_schema`).
 */
export function toAnthropicTools(
  tools: readonly ToolDefinition[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    // Anthropic requires an object schema even for a no-argument tool.
    input_schema: t.function.parameters ?? {
      type: "object",
      properties: {},
    },
  }));
}

/** `tool_use` content blocks from a non-streaming response. */
export function readAnthropicToolCalls(
  payload: Record<string, unknown>,
): ToolCallPart[] | undefined {
  if (!Array.isArray(payload.content)) return undefined;
  const calls = payload.content
    .filter((entry: Record<string, unknown>) => entry.type === "tool_use")
    .map((entry: Record<string, unknown>) => ({
      id: String(entry.id ?? ""),
      name: String(entry.name ?? ""),
      arguments: JSON.stringify(entry.input ?? {}),
    }));
  return calls.length > 0 ? calls : undefined;
}

/** Tool arguments travel as a JSON string; Anthropic wants the object. */
function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed argument string is the model's problem to see, not ours to
    // hide — forward it verbatim so the error surfaces at the provider.
    return { _raw: raw };
  }
}

function isToolResultContent(content: string | readonly unknown[]): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) => (block as Record<string, unknown>)?.type === "tool_result",
    )
  );
}

export function toAnthropicMessages(messages: TextMessage[]): {
  system: string;
  messages: Array<{ role: string; content: string | readonly unknown[] }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => anthropicSystemText(m.content))
    .filter(Boolean)
    .join("\n\n");

  const out: Array<{ role: string; content: string | readonly unknown[] }> = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;

    // Tool results ride on a `user` turn as `tool_result` blocks. Anthropic
    // requires every result for one assistant turn's parallel calls to sit in
    // a SINGLE user message, so consecutive tool messages merge.
    if (msg.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: anthropicSystemText(msg.content),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && isToolResultContent(last.content)) {
        last.content = [...(last.content as readonly unknown[]), block];
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") continue;

    // An assistant turn that invoked tools must replay those calls as
    // `tool_use` blocks, or the follow-up `tool_result` has nothing to bind to
    // and Anthropic rejects the request.
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const serialized = serializeAnthropicContent(msg.content);
      const textBlocks =
        typeof serialized === "string"
          ? serialized
            ? [{ type: "text", text: serialized }]
            : []
          : [...serialized];
      out.push({
        role: "assistant",
        content: [
          ...textBlocks,
          ...msg.toolCalls.map((tc) => ({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: parseToolArguments(tc.arguments),
          })),
        ],
      });
      continue;
    }

    out.push({
      role: msg.role,
      content: serializeAnthropicContent(msg.content),
    });
  }

  return { system, messages: out };
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
