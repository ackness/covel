import { narratorOnlyLoreIssues } from "@covel/shared";

/** A boundary failure must not fall back to regenerating the whole document. */
export class LoreBoundaryError extends Error {}

export type LorePart =
  | { readonly kind: "marker"; readonly text: string }
  | { readonly kind: "text"; readonly text: string; readonly hidden: boolean };

/** Keep the author's marker lines outside every model-controlled fragment. */
export function splitLore(lore: string): readonly LorePart[] {
  const issues = narratorOnlyLoreIssues(lore);
  if (issues.length)
    throw new LoreBoundaryError(
      `WORLD.md narrator-only boundaries are invalid (${issues.map((issue) => `${issue.kind} at line ${issue.line}`).join(", ")}); fix the source markers before transforming it`,
    );
  const parts: LorePart[] = [];
  let hidden = false;
  let text = "";
  for (const line of lore.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^<!--\s*(\/?)\s*narrator[\s_-]*only\s*-->$/i.exec(
      line.trim(),
    );
    if (!marker) {
      text += line;
      continue;
    }
    parts.push({ kind: "text", text, hidden }, { kind: "marker", text: line });
    text = "";
    hidden = marker[1] !== "/";
  }
  parts.push({ kind: "text", text, hidden });
  return parts;
}

export function hasLoreBoundary(parts: readonly LorePart[]): boolean {
  return parts.some((part) => part.kind === "marker");
}

export function assertLoreFragment(text: string): void {
  if (hasLoreBoundary(splitLore(text)))
    throw new LoreBoundaryError(
      "A WORLD.md fragment response added narrator-only markers; its boundaries belong to the source document",
    );
}

/** Preserve the whitespace that separates a fragment from the marker lines. */
export function replaceLoreFragment(
  source: string,
  replacement: string,
): string {
  if (!source.trim()) return `${replacement.trim()}\n`;
  return `${/^\s*/.exec(source)![0]}${replacement.trim()}${/\s*$/.exec(source)![0]}`;
}

/**
 * A whole-package revision has seen hidden facts. It cannot safely rewrite
 * public prose. Keep that prose fixed, allow story edits inside the existing
 * hidden regions, and reconstruct with source-owned marker lines.
 * This deliberately does not attempt to infer semantic equivalence.
 */
export function mergeProtectedLore(current: string, revised: string): string {
  const source = splitLore(current);
  const target = splitLore(revised);
  if (!hasLoreBoundary(source)) return revised;
  const error = () =>
    new LoreBoundaryError(
      "WORLD.md revision cannot remove or move narrator-only boundaries or change player-visible text while hidden regions exist. Only edits inside existing hidden regions or UNCHANGED are supported; edit the source file directly for a visible-text or visibility change",
    );
  if (source.length !== target.length) throw error();
  return source
    .map((part, index) => {
      const next = target[index]!;
      if (part.kind !== next.kind) throw error();
      if (part.kind === "marker") return part.text;
      if (next.kind !== "text" || part.hidden !== next.hidden) throw error();
      if (!part.hidden) {
        if (part.text.trim() !== next.text.trim()) throw error();
        return part.text;
      }
      assertLoreFragment(next.text);
      return next.text.trim()
        ? replaceLoreFragment(part.text, next.text)
        : "\n";
    })
    .join("");
}
