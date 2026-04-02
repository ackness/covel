import type { TextMessage } from "@covel/ai-provider";

/** Target LLM provider format constraints */
export type NormalizeProvider = "openai" | "anthropic" | "generic";

/** Options for message normalization */
export interface NormalizeOptions {
  /** Target provider's message format constraints */
  provider?: NormalizeProvider;
}

/** Record of a repair action taken during normalization */
export interface RepairRecord {
  index: number;
  action: "merged" | "removed" | "reordered" | "repaired";
  reason: string;
}

/** Result of message normalization */
export interface NormalizeResult {
  messages: TextMessage[];
  repairs: RepairRecord[];
}

/**
 * Normalize a message sequence to be wire-valid for LLM APIs.
 *
 * Rules applied in order:
 * 1. Remove messages with empty content
 * 2. Merge consecutive messages with the same role
 * 3. Ensure sequence starts with system or user (not assistant)
 * 4. Handle trailing system messages
 * 5. Provider-specific constraints (e.g. Anthropic: system only at start)
 */
export function normalizeMessages(
  messages: readonly TextMessage[],
  options?: NormalizeOptions
): NormalizeResult {
  const provider = options?.provider ?? "generic";
  const repairs: RepairRecord[] = [];

  // Work on a mutable copy
  let result: TextMessage[] = messages.map((m) => ({ ...m }));

  // ── Rule 1: Remove empty messages ────────────────────────────────
  result = filterEmpty(result, repairs);

  // ── Rule 2: Merge consecutive same-role messages ─────────────────
  result = mergeConsecutive(result, repairs);

  // ── Rule 3: Ensure sequence starts with system or user ───────────
  result = ensureValidStart(result, repairs);

  // ── Rule 4: Handle trailing system messages ──────────────────────
  result = handleTrailingSystem(result, repairs);

  // ── Rule 5: Provider-specific constraints ────────────────────────
  if (provider === "anthropic") {
    result = enforceAnthropicRules(result, repairs);
  }

  return { messages: result, repairs };
}

/** Remove messages with empty or whitespace-only content. */
function filterEmpty(
  messages: TextMessage[],
  repairs: RepairRecord[]
): TextMessage[] {
  return messages.filter((msg, i) => {
    if (!msg.content || msg.content.trim() === "") {
      repairs.push({
        index: i,
        action: "removed",
        reason: "empty content",
      });
      return false;
    }
    return true;
  });
}

/** Merge consecutive messages with the same role. */
function mergeConsecutive(
  messages: TextMessage[],
  repairs: RepairRecord[]
): TextMessage[] {
  if (messages.length <= 1) return messages;

  const merged: TextMessage[] = [{ ...messages[0] }];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (curr.role === prev.role) {
      prev.content = `${prev.content}\n\n${curr.content}`;
      repairs.push({
        index: i,
        action: "merged",
        reason: `consecutive ${curr.role} messages merged`,
      });
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

/** Ensure the message sequence starts with system or user, not assistant. */
function ensureValidStart(
  messages: TextMessage[],
  repairs: RepairRecord[]
): TextMessage[] {
  if (messages.length === 0) return messages;

  // Find first non-assistant message
  const firstNonAssistant = messages.findIndex((m) => m.role !== "assistant");

  if (firstNonAssistant === -1) {
    // All messages are assistant — prepend a minimal user message
    repairs.push({
      index: 0,
      action: "reordered",
      reason: "all messages are assistant, prepended user message",
    });
    return [{ role: "user", content: "Continue." }, ...messages];
  }

  if (firstNonAssistant > 0) {
    // Move leading assistant messages after the first system/user
    const leading = messages.slice(0, firstNonAssistant);
    const rest = messages.slice(firstNonAssistant);
    repairs.push({
      index: 0,
      action: "reordered",
      reason: `moved ${firstNonAssistant} leading assistant message(s) after first system/user`,
    });
    return [...rest.slice(0, 1), ...leading, ...rest.slice(1)];
  }

  return messages;
}

/** Handle trailing system messages — convert to user context. */
function handleTrailingSystem(
  messages: TextMessage[],
  repairs: RepairRecord[]
): TextMessage[] {
  if (messages.length === 0) return messages;

  const last = messages[messages.length - 1];
  if (last.role === "system" && messages.length > 1) {
    repairs.push({
      index: messages.length - 1,
      action: "repaired",
      reason: "trailing system message converted to user context",
    });
    return [
      ...messages.slice(0, -1),
      { role: "user", content: last.content },
    ];
  }

  return messages;
}

/**
 * Anthropic-specific: system messages can only appear at the start.
 * Any non-leading system messages are converted to user messages.
 */
function enforceAnthropicRules(
  messages: TextMessage[],
  repairs: RepairRecord[]
): TextMessage[] {
  let passedSystem = false;

  return messages.map((msg, i) => {
    if (msg.role === "system") {
      if (passedSystem) {
        repairs.push({
          index: i,
          action: "repaired",
          reason: "non-leading system message converted to user (Anthropic constraint)",
        });
        return { role: "user", content: msg.content };
      }
    } else {
      passedSystem = true;
    }
    return msg;
  });
}
