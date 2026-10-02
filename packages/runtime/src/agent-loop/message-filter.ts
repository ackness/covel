/**
 * History message filtering for agent runtimes.
 *
 * Every agent runtime should see player/system messages, narrative-like text,
 * and its own previous outputs — but NOT the structured tool-output JSON of
 * OTHER plugins (guide, codex, character-tracker, npc-graph, …). Two distinct
 * problems, one filter:
 *   - Story runtimes (narrator) would otherwise mimic that JSON in their prose.
 *   - Post-turn extraction runtimes (character-tracker / codex / extractor /
 *     scene-prompts) would otherwise carry every other plugin's JSON output
 *     forward turn after turn — an unbounded, compounding token cost, since
 *     these agents already receive the current narrative via `<narrator-output>`
 *     and their own state via plugin-data injects, and never read another
 *     plugin's output from history.
 * Extracted from `turn-agent-runtime.ts` so the runtime body stays focused on
 * orchestration.
 */

import type { RuntimeHistoryPolicy } from "@covel/shared";
import type { TurnMessageRecord } from "@covel/store";
import { looksLikeStructuredRuntimeOutput } from "../turn-executor/turn-output-helpers.js";

/**
 * Filter message history for an agent runtime. Applied to every agent runtime
 * (story and non-story alike).
 *
 * Kept conservative: player/system messages and narrative-like prose from any
 * runtime are always kept — only messages that look like another runtime's
 * structured tool output are dropped.
 */
export function filterRuntimeHistory(
  messageHistory: readonly TurnMessageRecord[],
  runtimeName: string,
): readonly TurnMessageRecord[] {
  return messageHistory.filter((m) => {
    if (m.sourceType === "player" || m.sourceType === "system") return true;
    if (m.sourceType === "runtime") {
      // Rows without text only carry trigger accounting or UI attachments.
      if (!m.content.trim()) return false;
      // Keep own previous outputs.
      if (m.sourceRuntimeId === runtimeName) return true;
      // Drop messages that look like another runtime's structured tool
      // output (JSON / fenced block / tool-tag formats).
      if (looksLikeStructuredRuntimeOutput(m.content)) return false;
      // Keep narrative-like text from other runtimes.
      return true;
    }
    return true;
  });
}

/**
 * Keep only the newest `maxTurns` turns of an already-filtered history.
 * Turns are counted by distinct `turnId`, newest first, so one turn's player
 * input and runtime outputs stay together. `maxTurns: 0` yields no history.
 */
export function applyHistoryWindow(
  messageHistory: readonly TurnMessageRecord[],
  policy: RuntimeHistoryPolicy,
): readonly TurnMessageRecord[] {
  const kept = new Set<string>();
  let start = messageHistory.length;
  while (start > 0) {
    const turnId = messageHistory[start - 1]!.turnId;
    if (!kept.has(turnId)) {
      if (kept.size === policy.maxTurns) break;
      kept.add(turnId);
    }
    start--;
  }
  return messageHistory.slice(start);
}
