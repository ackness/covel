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

/** Check the number and sequence of boundaries, not the meaning of the text. */
export function matchingLoreParts(
  source: readonly LorePart[],
  revised: string,
): readonly LorePart[] {
  const target = splitLore(revised);
  const error = () =>
    new LoreBoundaryError(
      "WORLD.md revision cannot add or remove narrator-only regions; keep the existing boundaries and edit content within each region",
    );
  if (source.length !== target.length) throw error();
  for (const [index, part] of source.entries()) {
    const next = target[index]!;
    if (part.kind !== next.kind) throw error();
    if (
      part.kind === "text" &&
      next.kind === "text" &&
      part.hidden !== next.hidden
    )
      throw error();
  }
  return target;
}
