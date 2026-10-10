import { stripPromptCacheMarkers } from "@covel/shared";
import { continuationItems } from "../provider-continuation.js";
import type { ProviderConfig } from "../../types.js";
import type {
  TextMessage,
  TextMessageContent,
  ToolCallPart,
  ToolDefinition,
} from "../../types.js";
import { mediaRefFallbackText } from "../common.js";

export function readAnthropicText(payload: Record<string, unknown>): string {
  return (Array.isArray(payload.content) ? payload.content : [])
    .filter(
      (entry: unknown): entry is { type: "text"; text: string } =>
        entry !== null &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "text" &&
        "text" in entry &&
        typeof entry.text === "string",
    )
    .map((entry) => entry.text)
    .join("");
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

/** Opens a conversation whose first kept message is the model's. */
const EARLIER_TURNS_OMITTED =
  "(The conversation continues from earlier turns.)";

export function toAnthropicMessages(
  messages: TextMessage[],
  target?: { model: string; config: ProviderConfig },
): {
  system: string;
  messages: Array<{ role: string; content: string | readonly unknown[] }>;
} {
  const firstConversation = messages.findIndex(
    (message) => message.role !== "system",
  );
  const leadingCount =
    firstConversation < 0 ? messages.length : firstConversation;
  const system = messages
    .slice(0, leadingCount)
    .map((m) => anthropicSystemText(m.content))
    .filter(Boolean)
    .join("\n\n");

  const out: Array<{ role: string; content: string | readonly unknown[] }> = [];
  // The last message ahead of the first instruction placed inside the
  // conversation: the committed history ends there.
  let historyEnd: (typeof out)[number] | undefined;
  let sawInstruction = false;
  for (const msg of messages.slice(leadingCount)) {
    // The wire has no system role inside messages. Keep late kernel instructions
    // in their original position so changing turn context preserves history.
    if (msg.role === "system") {
      if (!sawInstruction) historyEnd = out.at(-1);
      sawInstruction = true;
      out.push({
        role: "user",
        content: `<system-instruction>\n${stripPromptCacheMarkers(anthropicSystemText(msg.content))}\n</system-instruction>`,
      });
      continue;
    }

    // Tool results ride on a `user` turn as `tool_result` blocks. Anthropic
    // requires every result for one assistant turn's parallel calls to sit in
    // a SINGLE user message, so consecutive tool messages merge.
    if (msg.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: stripPromptCacheMarkers(anthropicSystemText(msg.content)),
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

    const native =
      target &&
      continuationItems(
        msg,
        "anthropic-messages-v1",
        target.model,
        target.config,
      );
    if (native) {
      out.push({ role: "assistant", content: native });
      continue;
    }

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

  // The Messages API takes a user turn first. A history that was pruned or
  // compacted can start with the model's turn; the text of this opener is
  // fixed, so it stays part of the cached prefix.
  if (out.length > 0 && out[0]!.role !== "user")
    out.unshift({ role: "user", content: EARLIER_TURNS_OMITTED });

  if (target?.config.cacheStrategy === "anthropic-explicit") {
    // One moving breakpoint covers conversation history and prior tool rounds.
    // Thinking blocks cannot carry explicit cache_control; cache the latest
    // text, image or tool block without mutating a provider continuation.
    let last: (typeof out)[number] | undefined;
    for (let index = out.length - 1; index >= 0 && !last; index--) {
      if (markCacheBreakpoint(out[index]!)) last = out[index];
    }
    // That breakpoint follows this turn's data, which sits after the history
    // (the turn context), so what it writes is read again only by the later
    // calls of this turn. The next turn's request repeats this one up to the
    // end of the history and no further: a second breakpoint there is the
    // entry the next turn reads. With the two system breakpoints this is the
    // request's fourth, the most the API takes.
    if (historyEnd && historyEnd !== last) markCacheBreakpoint(historyEnd);
  }
  return { system, messages: out };
}

/** Puts a cache breakpoint on the message's last block that can carry one. */
function markCacheBreakpoint(message: {
  content: string | readonly unknown[];
}): boolean {
  const blocks =
    typeof message.content === "string"
      ? message.content
        ? [{ type: "text", text: message.content }]
        : []
      : [...message.content];
  let cacheIndex = blocks.length - 1;
  while (
    cacheIndex >= 0 &&
    !["text", "image", "tool_use", "tool_result"].includes(
      String((blocks[cacheIndex] as Record<string, unknown>).type),
    )
  )
    cacheIndex--;

  if (cacheIndex < 0) return false;
  blocks[cacheIndex] = {
    ...(blocks[cacheIndex] as Record<string, unknown>),
    cache_control: { type: "ephemeral" },
  };
  message.content = blocks;
  return true;
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
  if (typeof content === "string" || content === null)
    return stripPromptCacheMarkers(content ?? "");
  return content.map((part) => {
    if (part.type === "text")
      return { type: "text", text: stripPromptCacheMarkers(part.text) };
    if (part.image.url) {
      return { type: "image", source: { type: "url", url: part.image.url } };
    }
    return { type: "text", text: mediaRefFallbackText(part) };
  });
}
