/** Aggregate world lore contributions for prompt assembly. */
import type {
  ContextBuildParams,
  ContextContribution,
  LorebookPromptPosition,
} from "./types.js";
import type { RenderedDepthContribution } from "./message-insertion.js";
const DEFAULT_DEPTH = 4;

export function activeContributions(
  params: ContextBuildParams,
): readonly ContextContribution[] {
  return params.sessionContext?.contributions ?? [];
}

export function renderSystemLoreContributions(
  contributions: readonly ContextContribution[],
  position: Exclude<LorebookPromptPosition, "at_depth">,
): string {
  const lines = contributions
    .filter(
      (contribution) =>
        contribution.kind === "lore_entry" &&
        contribution.position === position &&
        contribution.content.trim().length > 0,
    )
    .map((contribution, index) => ({ contribution, index }))
    .sort(
      (a, b) =>
        (a.contribution.order ?? 0) - (b.contribution.order ?? 0) ||
        a.index - b.index,
    )
    .map(({ contribution }) => contribution.content.trim());
  return lines.join("\n\n");
}

export function collectDepthContributions(
  contributions: readonly ContextContribution[],
): readonly RenderedDepthContribution[] {
  return contributions
    .filter(
      (contribution) =>
        contribution.kind === "lore_entry" &&
        contribution.position === "at_depth" &&
        contribution.content.trim().length > 0,
    )
    .map((contribution) => ({
      role: contribution.role ?? "system",
      depth: contribution.depth ?? DEFAULT_DEPTH,
      content: contribution.content.trim(),
      order: contribution.order ?? 0,
    }))
    .sort((a, b) => a.depth - b.depth || a.order - b.order);
}
