import type {
  MemorySystem,
  MemorySystemDeps,
  MemorySearchResult,
  EmbedFn,
} from "./types.js";
import { createKeywordRecallSearcher } from "./recall-search.js";
import { createKeywordArchivalSearcher } from "./archival-search.js";
import { supportsVector } from "@covel/store/vector";
import { createVectorRecallSearcher } from "./vector-recall-search.js";
import { createVectorArchivalSearcher } from "./vector-archival-search.js";
import {
  createNoopIngestor,
  createVectorIngestor,
  type VectorIngestor,
} from "./vector-ingest.js";
import { createMemoryBackgroundTasks } from "./background-tasks.js";

export function createMemorySystem(deps: MemorySystemDeps): MemorySystem {
  const { store } = deps;
  const background = createMemoryBackgroundTasks();
  // Searcher selection. Keyword search is always built — it is the dependency-
  // free default and the per-session fallback. When an `embed` function is
  // injected AND the store has a vector capability, recall/archival upgrade to
  // semantic (vector) search layered over keyword: each query first tries the
  // vector index and transparently falls back to keyword when a session has no
  // embedding model locked, the index is empty, or embedding fails. The two
  // halves of semantic memory — embed-on-write ingestion (below) and
  // vector-backed read — are now both present.
  const keywordRecall = createKeywordRecallSearcher(store);
  const keywordArchival = createKeywordArchivalSearcher(store);

  const vectorEnabled = Boolean(deps.embed) && supportsVector(store);

  const searchers = (embed = deps.embed) => {
    if (!vectorEnabled || !embed) {
      return { recall: keywordRecall, archival: keywordArchival };
    }
    return {
      recall: createVectorRecallSearcher({
        store,
        embed,
        fallback: keywordRecall,
      }),
      archival: createVectorArchivalSearcher({
        store,
        embed,
        fallback: keywordArchival,
      }),
    };
  };
  const { recall, archival } = searchers();
  const ingestor: VectorIngestor =
    vectorEnabled && deps.embed
      ? createVectorIngestor({
          store,
          embed: deps.embed,
          ...(deps.runIngestExclusive
            ? { runIngestExclusive: deps.runIngestExclusive }
            : {}),
        })
      : createNoopIngestor();

  return {
    recall,
    archival,
    async search(sessionId, query, { scope = "all", limit = 5 } = {}) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("Memory search limit must be a positive integer");
      }
      // This cache belongs to one query, never to the shared memory instance.
      // Keep model identity in the key in case a session changes vector target.
      const embeddings = new Map<string, ReturnType<EmbedFn>>();
      const embed: EmbedFn | undefined = deps.embed
        ? (texts, context) => {
            let pending = embeddings.get(context.modelId);
            if (!pending) {
              pending = Promise.resolve().then(() =>
                deps.embed!(texts, context),
              );
              embeddings.set(context.modelId, pending);
            }
            return pending;
          }
        : undefined;
      const tiers = scope === "all" ? searchers(embed) : { recall, archival };
      const [recalled, archived] = await Promise.all([
        scope === "archival"
          ? []
          : tiers.recall.search(sessionId, query, limit),
        scope === "recall"
          ? []
          : tiers.archival.search(sessionId, query, limit),
      ]);
      const results: MemorySearchResult[] = [];
      // Equal source weight, stable rank order, no comparison of uncalibrated
      // keyword and vector scores. An empty tier gives its slots to the other.
      for (let rank = 0; results.length < limit; rank++) {
        const recallHit = recalled[rank];
        const archivalHit = archived[rank];
        if (!recallHit && !archivalHit) break;
        if (recallHit) results.push({ ...recallHit, source: "recall" });
        if (archivalHit && results.length < limit) {
          results.push({
            ...archivalHit,
            source: `archival:${archivalHit.source}`,
          });
        }
      }
      return results;
    },
    drain: background.drain,
    pendingTaskCount: background.pendingTaskCount,

    ingest(sessionId) {
      return background.track(ingestor.ingest(sessionId), sessionId);
    },
  };
}
