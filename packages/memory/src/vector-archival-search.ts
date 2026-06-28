/**
 * Archival Memory — semantic (vector) cross-plugin knowledge search.
 *
 * Vector counterpart to {@link createKeywordArchivalSearcher}. Embeds the query
 * and runs KNN over the memory-owned archival vectors (lorebook + character
 * records, populated by {@link createVectorIngestor}). Returns the same
 * {@link ArchivalSearchResult} shape, with the same per-session graceful
 * degradation to the injected keyword searcher (no vector capability, no locked
 * embedding model, embed failure, or empty index).
 */

import type { DataStore } from "@covel/store";
import { supportsVector } from "@covel/store";
import type { ArchivalSearchResult, ArchivalSearcher } from "./types.js";
import {
  ARCHIVAL_NAMESPACE,
  distanceToScore,
  type EmbedFn,
  MEMORY_VECTOR_PLUGIN_ID,
} from "./vector-common.js";

interface ArchivalPayload {
  source?: ArchivalSearchResult["source"];
  key?: string;
  content?: string;
  pluginId?: string;
}

export function createVectorArchivalSearcher(deps: {
  readonly store: DataStore;
  readonly embed: EmbedFn;
  readonly fallback: ArchivalSearcher;
}): ArchivalSearcher {
  const { store, embed, fallback } = deps;

  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly ArchivalSearchResult[]> {
      if (!supportsVector(store)) {
        return fallback.search(sessionId, query, limit);
      }
      const target = await store.resolveSessionVectorTarget(sessionId);
      if (!target) {
        return fallback.search(sessionId, query, limit);
      }

      let results;
      try {
        const [queryVec] = await embed([query]);
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

      return results.map((r) => {
        const payload = parsePayload(r.payload);
        const result: ArchivalSearchResult = {
          key: payload.key ?? r.key,
          content: payload.content ?? "",
          score: distanceToScore(r.distance),
          source: payload.source ?? "lorebook",
          ...(payload.pluginId ? { pluginId: payload.pluginId } : {}),
        };
        return result;
      });
    },
  };
}

function parsePayload(raw: string | null): ArchivalPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ArchivalPayload;
  } catch {
    return {};
  }
}
