/**
 * Narrator-only parts of a world's lore (`WORLD.md`).
 *
 * The lore has two readers: the model reads all of it, and the player reads
 * it in the World tab. An author puts what only the narrator may know (hidden
 * plotlines, how to run the game) between two HTML comment lines:
 *
 *     <!-- narrator-only -->
 *     ...
 *     <!-- /narrator-only -->
 *
 * The model reads those parts without the two marker lines; the player's view
 * leaves them out. This keeps spoilers out of sight; it is not secrecy: the
 * world record and the package files hold the whole text.
 *
 * A marker is a line of its own. Every unclear case hides: a block with no
 * closing line runs to the end of the text, and a comment line that names
 * `narrator-only` in any other way opens a block. A marker line inside a
 * fenced code block is a marker too.
 */

const NARRATOR_ONLY_OPEN = "<!-- narrator-only -->";
const NARRATOR_ONLY_CLOSE = "<!-- /narrator-only -->";

const OPEN = /^<!--\s*narrator[\s_-]*only\s*-->$/i;
const CLOSE = /^<!--\s*\/\s*narrator[\s_-]*only\s*-->$/i;
const MENTION = /^<!--.*narrator[\s_-]*only.*-->$/i;

export interface NarratorOnlyLoreIssue {
  /** 1-based line of the marker. */
  readonly line: number;
  readonly kind: "unclosed" | "unopened" | "nested" | "unrecognized";
}

interface ScannedLine {
  readonly text: string;
  readonly marker: boolean;
  /** Inside a narrator-only block; false for the marker lines. */
  readonly narratorOnly: boolean;
}

function scan(lore: string): {
  lines: ScannedLine[];
  issues: NarratorOnlyLoreIssue[];
} {
  const lines: ScannedLine[] = [];
  const issues: NarratorOnlyLoreIssue[] = [];
  let openedAt = 0;
  for (const [index, text] of lore.split("\n").entries()) {
    const line = index + 1;
    const trimmed = text.trim();
    if (!MENTION.test(trimmed)) {
      lines.push({ text, marker: false, narratorOnly: openedAt > 0 });
      continue;
    }
    lines.push({ text, marker: true, narratorOnly: false });
    if (CLOSE.test(trimmed)) {
      if (openedAt === 0) issues.push({ line, kind: "unopened" });
      openedAt = 0;
      continue;
    }
    if (!OPEN.test(trimmed)) issues.push({ line, kind: "unrecognized" });
    else if (openedAt > 0) issues.push({ line, kind: "nested" });
    if (openedAt === 0) openedAt = line;
  }
  if (openedAt > 0) issues.push({ line: openedAt, kind: "unclosed" });
  return { lines, issues };
}

/**
 * The scanned lines that `keep` accepts. A marker line goes together with one
 * blank line after it when a blank line is before it too, so that the text
 * around a block reads as if the markers were never written.
 */
function joinLines(lore: string, keep: (line: ScannedLine) => boolean): string {
  const kept: string[] = [];
  let afterMarker = false;
  for (const line of scan(lore).lines) {
    if (line.marker) {
      afterMarker = true;
      continue;
    }
    if (!keep(line)) continue;
    const blank = line.text.trim() === "";
    const blankBefore = (kept.at(-1) ?? "").trim() === "";
    if (afterMarker && blank && blankBefore) {
      afterMarker = false;
      continue;
    }
    afterMarker = false;
    kept.push(line.text);
  }
  return kept.join("\n");
}

/** The lore a player may read: the text without its narrator-only blocks. */
export function playerVisibleLore(lore: string): string {
  return joinLines(lore, (line) => !line.narratorOnly);
}

/** The lore the model reads: all of the text, without the marker lines. */
export function narratorLore(lore: string): string {
  return joinLines(lore, () => true);
}

/** Marker faults of a lore text, for `validate:world`. */
export function narratorOnlyLoreIssues(
  lore: string,
): readonly NarratorOnlyLoreIssue[] {
  return scan(lore).issues;
}

/**
 * `visible` followed by the narrator-only blocks of `source`. A player who
 * edits the visible lore of a world keeps what the narrator alone knows;
 * `playerVisibleLore` of the result is `visible` again.
 */
export function withNarratorOnlyLore(visible: string, source: string): string {
  const blocks: string[] = [];
  let open = false;
  for (const line of scan(source).lines) {
    if (!line.narratorOnly) {
      if (open) blocks.push(NARRATOR_ONLY_CLOSE);
      open = false;
      continue;
    }
    if (!open) blocks.push(NARRATOR_ONLY_OPEN);
    open = true;
    blocks.push(line.text);
  }
  if (open) blocks.push(NARRATOR_ONLY_CLOSE);
  return blocks.length > 0 ? `${visible}\n${blocks.join("\n")}` : visible;
}
