import { cutText } from "./sanitize-text.js";
import type { ParsedLorebook } from "./lorebook-schema.js";
import { ImportReporter, safeFieldName } from "./report.js";

export interface LoreEntry {
  id: string;
  title?: string;
  content: string;
  keys: string[];
  strategy: "constant" | "selective";
  enabled: boolean;
  insertionOrder: number;
  position: "before_plugin" | "after_plugin";
  extra?: { scanDepth: number };
}
const mapped = new Set([
  "keys",
  "key",
  "content",
  "name",
  "comment",
  "constant",
  "enabled",
  "disable",
  "insertion_order",
  "order",
  "position",
  "scanDepth",
]);
const secondary = new Set([
  "secondary_keys",
  "keysecondary",
  "selective",
  "selectiveLogic",
]);
export function convertLorebook(
  book: ParsedLorebook,
  options: {
    source: string;
    sourceSlug: string;
    reporter: ImportReporter;
    text(value: string | undefined, field: string, limit?: number): string;
    usedIds: Set<string>;
    budget: { seen: number };
  },
): LoreEntry[] {
  const { source, sourceSlug, reporter, text, usedIds, budget } = options;
  for (const key of book.ignored)
    reporter.add(
      "info",
      "field-ignored",
      source,
      "Unmapped lorebook field was omitted",
      safeFieldName(key),
    );
  const result: LoreEntry[] = [];
  for (const [index, entry] of book.entries.entries()) {
    budget.seen++;
    if (budget.seen > 2000) {
      reporter.add(
        "warning",
        "entries-limit",
        source,
        "Entries beyond the total limit of 2000 were omitted",
      );
      continue;
    }
    let hasSecondary = false;
    for (const key of Object.keys(entry)) {
      if (mapped.has(key)) continue;
      if (secondary.has(key)) hasSecondary = true;
      else
        reporter.add(
          "warning",
          "lorebook-feature-dropped",
          source,
          "Unsupported lorebook feature was omitted",
          safeFieldName(key),
        );
    }
    if (hasSecondary)
      reporter.add(
        "warning",
        "lorebook-feature-dropped",
        source,
        "Secondary key matching was omitted",
        "secondary-keys",
      );
    const content = text(entry.content, "content", 20000).trim();
    if (!content) {
      reporter.add(
        "info",
        "entries-skipped-empty",
        source,
        "Empty lorebook entry was skipped",
      );
      continue;
    }
    const keys: string[] = [];
    const seenKeys = new Set<string>();
    for (const rawKey of entry.keys ?? entry.key ?? []) {
      let key = text(rawKey, "keys", 3 * 1024 * 1024).trim();
      if (/^\/[\s\S]*\/[a-z]*$/i.test(key)) {
        reporter.add(
          "warning",
          "regex-keys-dropped",
          source,
          "Regular expression keys were omitted",
        );
        continue;
      }
      if (key.length > 200) {
        key = cutText(key, 200);
        reporter.add(
          "warning",
          "text-truncated",
          source,
          "Keyword was shortened to 200 characters",
          "keys",
        );
      }
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        keys.push(key);
      }
    }
    if (keys.length > 64)
      reporter.add(
        "warning",
        "text-truncated",
        source,
        "Keys beyond the limit of 64 were omitted",
        "keys",
        keys.length - 64,
      );
    keys.length = Math.min(keys.length, 64);
    if (!entry.constant && keys.length === 0) {
      reporter.add(
        "warning",
        "entry-skipped-no-keys",
        source,
        "Selective entry with no literal keys was skipped",
      );
      continue;
    }
    let id = `st-${sourceSlug}-${index + 1}`;
    for (let suffix = 2; usedIds.has(id); suffix++)
      id = `st-${sourceSlug}-${index + 1}-${suffix}`;
    usedIds.add(id);
    const position =
      entry.position === "before_char" || entry.position === 0
        ? "before_plugin"
        : "after_plugin";
    if (
      entry.position !== undefined &&
      entry.position !== "before_char" &&
      entry.position !== "after_char" &&
      entry.position !== 0
    )
      reporter.add(
        "warning",
        "lorebook-feature-dropped",
        source,
        "Position was reduced to after_plugin",
        "position",
      );
    for (const field of ["insertion_order", "order"] as const) {
      if (Object.hasOwn(entry, field) && entry[field] === undefined)
        reporter.add(
          "info",
          "field-ignored",
          source,
          "Invalid insertion order was replaced by the default",
          field,
        );
    }
    const title = text(entry.name ?? entry.comment, "title", 120).trim();
    result.push({
      id,
      ...(title ? { title } : {}),
      content,
      keys,
      strategy: entry.constant ? "constant" : "selective",
      enabled: entry.disable === true ? false : (entry.enabled ?? true),
      insertionOrder: entry.insertion_order ?? entry.order ?? 100,
      position,
      ...(entry.scanDepth != null
        ? {
            extra: {
              scanDepth: Math.min(20, Math.max(0, Math.trunc(entry.scanDepth))),
            },
          }
        : {}),
    });
  }
  return result;
}
