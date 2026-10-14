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
import { supportsVector } from "@covel/store/vector";
import type { ArchivalSearchResult, ArchivalSearcher } from "./types.js";
import {
  ARCHIVAL_NAMESPACE,
  distanceToScore,
  type EmbedFn,
  MEMORY_VECTOR_PLUGIN_ID,
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
      if (!supportsVector(store)) {
        return fallback.search(sessionId, query, limit);
      }
      let results;
      let items;
      try {
        const target = await store.resolveSessionVectorTarget(sessionId);
        if (!target) {
          return fallback.search(sessionId, query, limit);
        }
        const [queryVec] = await embed([query], {
          sessionId,
          modelId: target.modelId,
        });
        if (!queryVec || queryVec.length === 0) {
          return fallback.search(sessionId, query, limit);
        }
        results = await store.searchVectors({
          sessionId,
          query: queryVec,
          topK: limit,
          pluginId: MEMORY_VECTOR_PLUGIN_ID,
          namespace: ARCHIVAL_NAMESPACE,
        });
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
        // eslint-disable-next-line no-console
        console.warn(
          `[memory] vector archival failed for ${sessionId}, falling back to keyword: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return fallback.search(sessionId, query, limit);
      }

      if (results.length === 0) {
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
          undefined,
          distanceToScore(row.distance),
        ),
      );
    },
  };
}

function payloadContent(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null &&
      typeof value === "object" &&
      "content" in value &&
      typeof value.content === "string"
      ? value.content
      : null;
  } catch {
    return null;
  }
}
