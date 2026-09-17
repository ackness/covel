/**
 * Allocate opaque entity references with a readable label when possible.
 * No process-local counter: IDs must survive restarts and independent workers.
 * Existing IDs remain valid; callers must retain returned IDs when updating.
 */

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 24)
    .replace(/-$/, "");
}

/**
 * Allocate a new ID, including for repeated or non-ASCII labels.
 * The session argument is retained for source compatibility, not uniqueness.
 * Names are display text, not identity; deduplicate against stored entities.
 */
export function shortId(
  prefix: string,
  label: string,
  _sessionId: string,
): string {
  const slug = slugify(label);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return [prefix, ...(slug ? [slug] : []), nonce].join("-");
}

/** Allocate independent IDs; slug truncation and duplicate labels cannot alias. */
export function shortIdBatch(
  prefix: string,
  labels: readonly string[],
  sessionId: string,
): string[] {
  return labels.map((label) => shortId(prefix, label, sessionId));
}
