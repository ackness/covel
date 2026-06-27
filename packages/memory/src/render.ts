/**
 * Core Memory Renderer — Format memory blocks for prompt injection.
 *
 * Renders core memory blocks as XML-tagged sections that the LLM can
 * read as part of its system context. Placed in the prompt between
 * framework preamble and plugin instructions.
 *
 * Display names are schema-driven: each block carries its localized
 * `displayName` (attached by the manager from the active block schema). For
 * blocks lacking one, this falls back to the default block schema, then to the
 * raw label — never a hardcoded per-label map.
 */

import { resolveI18nText } from "@covel/shared";
import type { CoreMemoryBlock } from "./types.js";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "./types.js";

/** Default display-name lookup, derived from the default block schema. */
const DEFAULT_DISPLAY_NAMES = new Map(
  DEFAULT_CORE_MEMORY_BLOCKS.map((b) => [b.label, b.displayName] as const),
);

/**
 * Render core memory blocks as a `[Core Memory]` prompt section.
 *
 * Format:
 * ```
 * [Core Memory]
 * <story_state>
 * # Story State
 * ...
 * </story_state>
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

  const header = locale?.startsWith("en") ? "[Core Memory]" : "[核心记忆]";

  const sections = nonEmpty.map((b) => {
    const displayName = b.displayName ?? DEFAULT_DISPLAY_NAMES.get(b.label);
    const label = resolveI18nText(displayName, locale) ?? b.label;
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
