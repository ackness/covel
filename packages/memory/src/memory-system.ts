import type {
  MemorySystem,
  MemorySystemDeps,
  RecallSearcher,
  ArchivalSearcher,
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

  let recall: RecallSearcher;
  let archival: ArchivalSearcher;
  let ingestor: VectorIngestor;
  if (vectorEnabled && deps.embed) {
    const embed = deps.embed;
    recall = createVectorRecallSearcher({
      store,
      embed,
      fallback: keywordRecall,
    });
    archival = createVectorArchivalSearcher({
      store,
      embed,
      fallback: keywordArchival,
    });
    ingestor = createVectorIngestor({
      store,
      embed,
      ...(deps.runIngestExclusive
        ? { runIngestExclusive: deps.runIngestExclusive }
        : {}),
    });
  } else {
    recall = keywordRecall;
    archival = keywordArchival;
    ingestor = createNoopIngestor();
  }

  return {
    recall,
    archival,
    drain: background.drain,
    pendingTaskCount: background.pendingTaskCount,

    ingest(sessionId) {
      return background.track(ingestor.ingest(sessionId), sessionId);
    },
  };
}
