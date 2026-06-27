/**
 * Recall Memory — semantic (vector) conversation-history search.
 *
 * The vector counterpart to {@link createKeywordRecallSearcher}. It embeds the
 * query, runs a KNN search against the memory-owned recall vectors (populated
 * by {@link createVectorIngestor}), and returns the same {@link RecallSearchResult}
 * shape so callers (the `memory-search` tool, prompt assembly) are agnostic to
 * which searcher is wired.
 *
 * Graceful degradation is built in per-session, not just per-deployment: if the
 * store has no vector capability, the session has no embedding model locked, or
 * the embed call fails, it transparently falls back to the injected keyword
 * searcher. A deployment with no embedding configured therefore behaves exactly
 * as before.
 */

import type { DataStore } from "@covel/store";
import { supportsVector } from "@covel/store";
import type { RecallSearchResult, RecallSearcher } from "./types.js";
import {
  distanceToScore,
  type EmbedFn,
  MEMORY_VECTOR_PLUGIN_ID,
  RECALL_NAMESPACE,
} from "./vector-common.js";

interface RecallPayload {
  turnId?: string;
  role?: string;
  content?: string;
  createdAt?: string;
}

export function createVectorRecallSearcher(deps: {
  readonly store: DataStore;
  readonly embed: EmbedFn;
  /** Keyword searcher used when vectors are unavailable for the session. */
  readonly fallback: RecallSearcher;
}): RecallSearcher {
  const { store, embed, fallback } = deps;

  return {
    async search(
      sessionId,
      query,
      limit = 10,
    ): Promise<readonly RecallSearchResult[]> {
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
          namespace: RECALL_NAMESPACE,
        });
      } catch (err) {
        // Embedding outage / KNN failure must never break a turn — fall back.
        // eslint-disable-next-line no-console
        console.warn(
          `[memory] vector recall failed for ${sessionId}, falling back to keyword: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return fallback.search(sessionId, query, limit);
      }

      // Empty vector table (e.g. brand-new session that hasn't ingested yet) —
      // keyword still has the raw messages, so prefer it over zero results.
      if (results.length === 0) {
        return fallback.search(sessionId, query, limit);
      }

      return results.map((r) => {
        const payload = parsePayload(r.payload);
        return {
          turnId: payload.turnId ?? "",
          role: payload.role ?? "assistant",
          content: payload.content ?? "",
          score: distanceToScore(r.distance),
          timestamp: payload.createdAt ?? "",
        };
      });
    },
  };
}

function parsePayload(raw: string | null): RecallPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RecallPayload;
  } catch {
    return {};
  }
}
