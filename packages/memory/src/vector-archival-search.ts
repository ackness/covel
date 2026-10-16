/**
 * Archival Memory — semantic (vector) cross-plugin knowledge search.
 *
 * Vector counterpart to {@link createKeywordArchivalSearcher}. Embeds the query
 * and runs KNN over the memory-owned archival vectors (lorebook, character
 * and searchable plugin data records, populated by {@link createVectorIngestor}). Returns the same
 * {@link ArchivalSearchResult} shape, with the same per-session graceful
 * degradation to the injected keyword searcher (no vector capability, no locked
 * embedding model, embed failure, or empty index).
 */

import {
  parseArchivalVecKey,
  readArchivalItem,
  searchableSourceKey,
  type ArchivalItem,
  type SearchablePluginData,
  type SearchablePluginDataResolver,
} from "./archival-items.js";
import { archivalResult } from "./archival-search.js";
import type { ArchivalLookupStore } from "./store-contracts.js";
import type { ArchivalSearchResult, ArchivalSearcher } from "./types.js";
import {
  ARCHIVAL_NAMESPACE,
  distanceToScore,
  type EmbedFn,
  isEmbeddingModelChanged,
  searchSessionVectors,
  payloadContent,
} from "./vector-common.js";

export function createVectorArchivalSearcher(deps: {
  readonly store: ArchivalLookupStore;
  readonly embed: EmbedFn;
  readonly fallback: ArchivalSearcher;
  readonly pluginData?: SearchablePluginDataResolver;
}): ArchivalSearcher {
  const { store, embed, fallback, pluginData } = deps;

  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly ArchivalSearchResult[]> {
      let results;
      let items;
      try {
        results = await searchSessionVectors(
          store,
          embed,
          sessionId,
          query,
          limit,
          ARCHIVAL_NAMESPACE,
        );
        if (!results) return fallback.search(sessionId, query, limit);
        // Read only the records the hits name, not the whole corpus.
        const sources = new Map<string, SearchablePluginData>(
          (pluginData ? await pluginData(sessionId) : []).map((source) => [
            searchableSourceKey(source.pluginId, source.namespace),
            source,
          ]),
        );
        items = new Map<string, ArchivalItem | null>();
        for (const row of results) {
          const ref = parseArchivalVecKey(row.key);
          items.set(
            row.key,
            ref ? await readArchivalItem(store, sessionId, ref, sources) : null,
          );
        }
      } catch (err) {
        // A changed embedding model is reported once by ingestion.
        if (!isEmbeddingModelChanged(err)) {
          // eslint-disable-next-line no-console
          console.warn(
            `[memory] vector archival failed for ${sessionId}, falling back to keyword: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return fallback.search(sessionId, query, limit);
      }

      // The index is asynchronous. Never publish a deleted or changed source
      // just because its old embedding still ranks highly.
      if (
        results.some(
          (row) => items.get(row.key)?.text !== payloadContent(row.payload),
        )
      ) {
        return fallback.search(sessionId, query, limit);
      }
      return results.map((row) =>
        archivalResult(
          items.get(row.key)!,
          query,
          distanceToScore(row.distance),
        ),
      );
    },
  };
}
