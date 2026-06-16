/**
 * History message filtering for agent runtimes.
 *
 * Story runtimes (e.g. the narrator) should only see player/system messages
 * plus their own previous story outputs. Without this filter, structured
 * tool-output JSON from other plugins (guide, codex, character-tracker, …)
 * leaks into the story prompt and the LLM mimics those formats. Extracted from
 * `turn-agent-runtime.ts` so the runtime body stays focused on orchestration.
 */

import type { TurnMessageRecord } from "@covel/store";
import { looksLikeStructuredRuntimeOutput } from "./turn-output-helpers.js";

/**
 * Filter message history for a story-output runtime.
 *
 * Kept conservative: messages from runtimes not in the active set are kept
 * (we never drop unknown messages). Returns the input array unchanged for
 * non-story runtimes — call this only when `outputKind === "story"`.
 */
export function filterHistoryForStory(
  messageHistory: readonly TurnMessageRecord[],
  runtimeName: string,
): readonly TurnMessageRecord[] {
  return messageHistory.filter((m) => {
    if (m.sourceType === "player" || m.sourceType === "system") return true;
    if (m.sourceType === "runtime") {
      // Keep own previous outputs.
      if (m.sourceRuntimeId === runtimeName) return true;
      // Filter out messages that look like structured tool output so the
      // narrator doesn't mimic JSON / block / category-list formats.
      if (looksLikeStructuredRuntimeOutput(m.content)) return false;
      // Keep narrative-like text from other runtimes.
      return true;
    }
    return true;
  });
}
