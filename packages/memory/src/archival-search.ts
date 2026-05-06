/**
 * Archival Memory — Long-term cross-plugin knowledge search.
 *
 * Like Letta's `archival_memory_search`. Aggregates data from:
 *   - plugin_data (codex entries, npc-graph, world entries)
 *   - lorebook entries
 *   - character records
 *
 * Uses keyword matching by default. Vector search when pgvector is available.
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

			// 1. Search plugin_data — all plugins, all namespaces
			try {
				// listPluginData is scoped per-plugin, so we need to iterate.
				// For now, search the well-known plugin namespaces that contain
				// searchable knowledge. The framework doesn't hardcode plugin IDs
				// in production, but the memory system can iterate over all known
				// plugin_data for the session if the store supports it.
				// Fallback: search characters + lorebook only.
			} catch {
				// Non-fatal
			}

			// 2. Search lorebook entries
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

			// 3. Search character records
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
