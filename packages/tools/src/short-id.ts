/**
 * Short ID generator for LLM-facing entity references.
 *
 * Generates concise, semantic IDs that are token-efficient and easy for LLMs
 * to reproduce accurately. UUIDs remain as DB primary keys; short IDs are used
 * only in tool parameters, return values, and LLM context injection.
 *
 * Format: `<prefix>-<slug>` where slug is a sanitized, lowercase,
 * hyphen-separated string derived from a human-readable label.
 *
 * Examples:
 *   shortId('char', '林若风')        → 'char-lin-ruo-feng'  (if pinyin available)
 *   shortId('char', '林若风')        → 'char-1'             (fallback: counter)
 *   shortId('item', 'Dragon Sword') → 'item-dragon-sword'
 *   shortId('npc', 'Old Man')       → 'npc-old-man'
 *   shortId('codex', 'Fire Magic')  → 'codex-fire-magic'
 */

// ── Session-scoped counter registry ─────────────────────────────

const counters = new Map<string, Map<string, number>>();

/**
 * Get the next counter value for a (session, prefix) pair.
 */
function nextCounter(sessionId: string, prefix: string): number {
  let sessionCounters = counters.get(sessionId);
  if (!sessionCounters) {
    sessionCounters = new Map();
    counters.set(sessionId, sessionCounters);
  }
  const current = sessionCounters.get(prefix) ?? 0;
  const next = current + 1;
  sessionCounters.set(prefix, next);
  return next;
}

/**
 * Clean up counters for a session (call on session delete).
 */
export function clearSessionCounters(sessionId: string): void {
  counters.delete(sessionId);
}

// ── Slug generation ─────────────────────────────────────────────

/** ASCII-safe slug: lowercase, hyphens only, max length. */
function slugify(label: string, maxLength = 24): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-ASCII
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .slice(0, maxLength)
    .replace(/-$/, '');              // trim trailing hyphen

  return slug;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Generate a short, semantic ID for LLM-facing use.
 *
 * @param prefix - Entity type prefix (e.g. 'char', 'item', 'codex', 'npc')
 * @param label - Human-readable label (e.g. character name, item name)
 * @param sessionId - Session ID for counter scoping
 * @returns Short ID like 'char-dragon-sword' or 'codex-3'
 */
export function shortId(prefix: string, label: string, sessionId: string): string {
  const slug = slugify(label);

  if (slug.length >= 2) {
    return `${prefix}-${slug}`;
  }

  // Fallback: counter-based for non-ASCII labels (CJK, emoji, etc.)
  const n = nextCounter(sessionId, prefix);
  return `${prefix}-${n}`;
}

/**
 * Generate a batch of short IDs with automatic dedup.
 * If two labels produce the same slug, appends a counter suffix.
 *
 * @param prefix - Entity type prefix
 * @param labels - Array of human-readable labels
 * @param sessionId - Session ID for counter scoping
 * @returns Array of unique short IDs
 */
export function shortIdBatch(prefix: string, labels: readonly string[], sessionId: string): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const base = shortId(prefix, label, sessionId);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  });
}
