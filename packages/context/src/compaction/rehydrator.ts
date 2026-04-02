import type { TextMessage } from "@covel/ai-provider";
import type { CharacterCard } from "@covel/shared";
import type { CompactedChatHistory } from "./types.js";
import { formatSection } from "../sections/index.js";

/**
 * Build a rehydrated chat history from compacted data.
 *
 * The result is a message sequence that can replace the original chat history:
 * 1. A system message with compaction summary + current state context
 * 2. The preserved recent messages
 *
 * This ensures the LLM has continuity after compaction.
 */
export function buildRehydratedHistory(
  compacted: CompactedChatHistory,
  currentState: Record<string, unknown>,
  characters: CharacterCard[]
): TextMessage[] {
  const messages: TextMessage[] = [];

  // Build rehydration context as a user message
  // (system messages are built by the prompt assembler, so we inject
  // compaction context as a user-role context message to avoid conflict)
  const rehydrationParts: string[] = [];

  // Compaction summary
  if (compacted.summary) {
    rehydrationParts.push(
      formatSection("compaction_summary", compacted.summary)
    );
  }

  // Current state (compact version)
  if (Object.keys(currentState).length > 0) {
    const stateStr = JSON.stringify(currentState, null, 2);
    // Only include if not too large
    if (stateStr.length < 4000) {
      rehydrationParts.push(
        formatSection("current_state_snapshot", stateStr)
      );
    }
  }

  // Active characters (compact version)
  if (characters.length > 0) {
    const charSummary = characters
      .map((c) => `- ${c.name} (${c.type}): ${c.description ?? ""}`)
      .join("\n");
    rehydrationParts.push(
      formatSection("active_characters_snapshot", charSummary)
    );
  }

  if (rehydrationParts.length > 0) {
    messages.push({
      role: "user",
      content:
        "[The following is a summary of earlier conversation that has been compacted to save context space.]\n\n" +
        rehydrationParts.join("\n\n"),
    });

    // Add a brief assistant acknowledgment to maintain valid alternation
    messages.push({
      role: "assistant",
      content:
        "I understand. I have the context from the compacted history and will continue from here.",
    });
  }

  // Append preserved recent messages
  messages.push(...compacted.recentMessages.map((m) => ({ ...m })));

  return messages;
}
