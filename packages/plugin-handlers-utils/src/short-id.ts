/**
 * Allocate entity references that read as words. Models read these IDs in
 * injected data and sometimes write them back, so every character costs
 * tokens and a long random part invites copy mistakes. IDs stay within
 * `[a-z0-9-]`, the charset blueprint, rule, and portable world-data IDs
 * require, so a label without ASCII letters or digits gets a short random
 * part instead of words.
 *
 * No process-local counter: IDs must survive restarts and independent workers.
 * Existing IDs remain valid; callers must retain returned IDs when updating.
 */

const MAX_SLUG_LENGTH = 32;

const randomPart = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

/** The label's ASCII letters and digits, lowercased and hyphenated. */
export function wordSlug(label: string): string {
  return (label.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .join("-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, "");
}

/**
 * A word ID: the prefix and the label's words (`npc-lin-yao`), with `-2`,
 * `-3`… when that ID is taken. Use it when the caller can see every existing
 * ID in the namespace; otherwise use `shortId`. A label with no ASCII words
 * gets an 8-hex random part (`char-3fa9c1d2`).
 */
export function wordId(
  prefix: string,
  label: string,
  taken: ReadonlySet<string>,
): string {
  const slug = wordSlug(label);
  if (!slug) {
    let id = `${prefix}-${randomPart()}`;
    while (taken.has(id)) id = `${prefix}-${randomPart()}`;
    return id;
  }
  const base = `${prefix}-${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Allocate a new ID without reading the namespace: the label's words plus an
 * 8-hex random part, so repeated labels and lossy slugs stay distinct.
 * The session argument is retained for source compatibility, not uniqueness.
 * Names are display text, not identity; deduplicate against stored entities.
 */
export function shortId(
  prefix: string,
  label: string,
  _sessionId: string,
): string {
  return [prefix, wordSlug(label), randomPart()].filter(Boolean).join("-");
}

/** Allocate independent IDs; slug truncation and duplicate labels cannot alias. */
export function shortIdBatch(
  prefix: string,
  labels: readonly string[],
  sessionId: string,
): string[] {
  return labels.map((label) => shortId(prefix, label, sessionId));
}
