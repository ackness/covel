/**
 * Core Memory Renderer — Format memory blocks for prompt injection.
 *
 * Renders core memory blocks as XML-tagged sections that the LLM can
 * read as part of its system context. Placed in the prompt between
 * framework preamble and plugin instructions.
 */

import type { CoreMemoryBlock } from "./types.js";

/** Human-readable labels for each block in Chinese. */
const BLOCK_LABELS_ZH: Record<string, string> = {
  story_state: "剧情状态",
  scene: "当前场景",
  character_relationships: "角色关系",
  player_profile: "玩家状态",
};

const BLOCK_LABELS_EN: Record<string, string> = {
  story_state: "Story State",
  scene: "Current Scene",
  character_relationships: "Character Relationships",
  player_profile: "Player Profile",
};

/**
 * Render core memory blocks as a `[Core Memory]` prompt section.
 *
 * Format:
 * ```
 * [Core Memory]
 * <story_state>
 * 主线：...
 * </story_state>
 * <scene>
 * ...
 * </scene>
 * ```
 *
 * Empty blocks are omitted. Returns empty string if all blocks are empty.
 */
export function renderCoreMemory(
  blocks: readonly CoreMemoryBlock[] | undefined,
  locale?: string,
): string {
  if (!blocks || blocks.length === 0) return "";

  const nonEmpty = blocks.filter((b) => b.content.trim());
  if (nonEmpty.length === 0) return "";

  const labels = locale?.startsWith("en") ? BLOCK_LABELS_EN : BLOCK_LABELS_ZH;
  const header = locale?.startsWith("en") ? "[Core Memory]" : "[核心记忆]";

  const sections = nonEmpty.map((b) => {
    const label = labels[b.label] ?? b.label;
    return `<${b.label}>\n# ${label}\n${b.content}\n</${b.label}>`;
  });

  return `${header}\n${sections.join("\n\n")}`;
}

/**
 * Render a compacted history summary for injection into the message section.
 * Replaces the compacted messages with a single summary block.
 */
export function renderCompactedSummary(
  summary: string,
  locale?: string,
): string {
  if (!summary.trim()) return "";

  const header = locale?.startsWith("en")
    ? "[Previous Story Summary]"
    : "[此前剧情摘要]";

  return `${header}\n${summary}`;
}
