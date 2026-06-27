/**
 * Archival Memory — Long-term cross-plugin knowledge search (keyword search).
 *
 * Like Letta's `archival_memory_search`, but **keyword-only**. Aggregates and
 * scores by term overlap across:
 *   - lorebook entries
 *   - character records
 *
 * (plugin_data is intentionally not iterated — see the note inside `search`.)
 *
 * This keyword searcher is now the **fallback** under the semantic (vector)
 * path: `createMemorySystem` wraps it with `createVectorArchivalSearcher` when
 * an `embed` function is injected and the store supports vectors (the ingestor
 * embeds lorebook + character records on write — see vector-archival-search.ts
 * / vector-ingest.ts). The vector searcher falls back here per-session when no
 * embedding model is locked, the index is empty, or embedding fails. Both
 * implement the {@link ArchivalSearcher} swap seam. See memory-system.ts.
 */

import type { DataStore } from "@covel/store";
import type { ArchivalSearchResult, ArchivalSearcher } from "./types.js";

/**
 * Create a keyword-based archival searcher.
 * Searches across plugin_data values, lorebook content, and character descriptions.
 */
export function createKeywordArchivalSearcher(
  store: DataStore,
): ArchivalSearcher {
  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly ArchivalSearchResult[]> {
      const results: ArchivalSearchResult[] = [];
      const queryLower = query.toLowerCase();
      const queryTerms = query
        .toLowerCase()
        .split(/[\s,.:;!?，。：；！？]+/)
        .filter((t) => t.length >= 2);

      if (queryTerms.length === 0) return [];

      // NOTE: plugin_data is intentionally NOT searched here. `listPluginData`
      // is scoped per-(plugin, namespace), and the framework must not iterate a
      // hardcoded plugin-ID list (isolation rule), so there is no plugin-agnostic
      // way to scan every plugin's data for a session via the keyword path.
      // Archival keyword search is therefore limited to lorebook + character
      // records below. A future vector path would index plugin_data on write
      // (under each plugin's own namespace) and lift this limitation.

      // 1. Search lorebook entries
      if (typeof store.listSessionLorebookEntries === "function") {
        try {
          const entries = await store.listSessionLorebookEntries(sessionId);
          for (const entry of entries) {
            const content = String(entry.content ?? "");
            const score = scoreText(content, queryLower, queryTerms);
            if (score > 0) {
              results.push({
                key: entry.keys?.[0] ?? entry.id,
                content: content.slice(0, 500),
                score,
                source: "lorebook",
                pluginId: entry.pluginId,
              });
            }
          }
        } catch {
          // Non-fatal — store may not support lorebook
        }
      }

      // 2. Search character records
      try {
        const characters = await store.listCharacters(sessionId);
        for (const char of characters) {
          const text = `${char.name} ${char.description ?? ""} ${JSON.stringify(char.fields ?? {})}`;
          const score = scoreText(text, queryLower, queryTerms);
          if (score > 0) {
            results.push({
              key: char.name,
              content:
                `[${char.type}] ${char.name}: ${char.description ?? ""}`.slice(
                  0,
                  500,
                ),
              score,
              source: "character",
            });
          }
        }
      } catch {
        // Non-fatal
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },
  };
}

/** Score a text block against query terms. Returns 0 if no match. */
function scoreText(
  text: string,
  queryLower: string,
  queryTerms: string[],
): number {
  const textLower = text.toLowerCase();

  // Exact substring match bonus
  if (textLower.includes(queryLower) && queryLower.length >= 2) {
    return 1.0;
  }

  // Term overlap scoring
  let matches = 0;
  for (const term of queryTerms) {
    if (textLower.includes(term)) matches++;
  }

  if (matches === 0) return 0;
  return (matches / queryTerms.length) * 0.8;
}
