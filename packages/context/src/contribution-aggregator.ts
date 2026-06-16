/**
 * Contribution aggregation for the segment-based prompt assembler.
 *
 * Collects and renders the session-context contributions (persona, lore) and
 * the per-manifest declarations (Author's Note, Post-History Instructions) that
 * feed segments 3, 4/6, 8, 9, and 10. Extracted from `prompt-assembler.ts` so
 * the assembler body focuses on segment composition.
 */

import type {
  AuthorsNoteDecl,
  PostHistoryDecl,
  RuntimeManifest,
} from "@covel/shared";
import { interpolateTemplate } from "./prompt-internals.js";
import type {
  ContextBuildParams,
  ContextContribution,
  LLMMessage,
} from "./types.js";
import type {
  RenderedAuthorsNote,
  RenderedDepthContribution,
} from "./message-insertion.js";

/** Default Author's Note insertion depth (SillyTavern default). */
export const DEFAULT_AUTHORS_NOTE_DEPTH = 4;

export function activeContributions(
  params: ContextBuildParams,
): readonly ContextContribution[] {
  return params.sessionContext?.contributions ?? [];
}

export function renderSystemPersonaContributions(
  contributions: readonly ContextContribution[],
  position: "seg3_prepend" | "seg3_append",
): string {
  const lines = contributions
    .filter(
      (contribution) =>
        contribution.kind === "persona_description" &&
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

export function renderSystemLoreContributions(
  contributions: readonly ContextContribution[],
  position: "before_plugin" | "after_plugin",
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
        (contribution.kind === "persona_description" ||
          contribution.kind === "lore_entry") &&
        contribution.position === "at_depth" &&
        contribution.content.trim().length > 0,
    )
    .map((contribution) => ({
      role: contribution.role ?? "system",
      depth: contribution.depth ?? DEFAULT_AUTHORS_NOTE_DEPTH,
      content: contribution.content.trim(),
      order: contribution.order ?? 0,
    }))
    .sort((a, b) => a.depth - b.depth || a.order - b.order);
}

/**
 * Resolve the priority-ordered list of manifests used for segment 9/10
 * aggregation. Defaults to the single current manifest when the caller
 * does not pass `activeManifests`.
 */
export function resolveActiveManifests(
  params: ContextBuildParams,
): readonly RuntimeManifest[] {
  const fromCaller = params.activeManifests;
  if (!fromCaller || fromCaller.length === 0) {
    return [params.manifest];
  }
  // Stable sort by ascending priority — matches scheduler semantics
  // (0 = highest, runs first → renders first).
  return [...fromCaller].sort(
    (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity),
  );
}

/**
 * Collect all Author's Note declarations from the active manifests,
 * interpolate their content against the caller's variable bag, and group
 * them by `(role, depth)` so adjacent notes merge into a single message.
 */
export function collectAuthorsNotes(
  manifests: readonly RuntimeManifest[],
  variables: Readonly<Record<string, unknown>>,
): readonly RenderedAuthorsNote[] {
  type Group = {
    readonly role: "system" | "user" | "assistant";
    readonly depth: number;
    readonly lines: string[];
  };
  const groups: Group[] = [];

  for (const manifest of manifests) {
    const decl: AuthorsNoteDecl | undefined = manifest.authorsNote;
    if (!decl) continue;
    const rendered = interpolateTemplate(decl.content, variables).trim();
    if (!rendered) continue;

    const role = decl.role ?? "system";
    const depth = decl.depth ?? DEFAULT_AUTHORS_NOTE_DEPTH;

    // Preserve declaration order within the same (role, depth) bucket.
    const existing = groups.find((g) => g.role === role && g.depth === depth);
    if (existing) {
      existing.lines.push(rendered);
    } else {
      groups.push({ role, depth, lines: [rendered] });
    }
  }

  return groups.map((g) => ({
    role: g.role,
    depth: g.depth,
    content: g.lines.join("\n\n"),
  }));
}

/**
 * Collect all Post-History Instruction declarations from the active
 * manifests and render them as a list of messages, one per unique role.
 * Notes sharing the same role are joined with a blank line.
 */
export function collectPostHistoryInstructions(
  manifests: readonly RuntimeManifest[],
  variables: Readonly<Record<string, unknown>>,
): readonly LLMMessage[] {
  type Group = {
    readonly role: "system" | "user";
    readonly lines: string[];
  };
  const groups: Group[] = [];

  for (const manifest of manifests) {
    const decl: PostHistoryDecl | undefined = manifest.postHistory;
    if (!decl) continue;
    const rendered = interpolateTemplate(decl.content, variables).trim();
    if (!rendered) continue;

    const role = decl.role ?? "system";
    const existing = groups.find((g) => g.role === role);
    if (existing) {
      existing.lines.push(rendered);
    } else {
      groups.push({ role, lines: [rendered] });
    }
  }

  return groups.map((g) => ({ role: g.role, content: g.lines.join("\n\n") }));
}
