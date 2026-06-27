/**
 * Unified Memory System facade.
 *
 * Creates and wires all three memory tiers + compaction into a single
 * object that the server bootstrap injects into the turn executor.
 */

import type {
  CompactionConfig,
  CompactionResult,
  CoreMemoryConfig,
  MemoryLLMAdapter,
  MemoryManager,
  MemorySystem,
  MemorySystemDeps,
  MemoryUpdater,
  MemoryUpdaterConfig,
  RecallSearcher,
  ArchivalSearcher,
} from "./types.js";
import { createMemoryManager } from "./core-memory.js";
import { createMemoryUpdater } from "./updater.js";
import { createKeywordRecallSearcher } from "./recall-search.js";
import { createKeywordArchivalSearcher } from "./archival-search.js";
import { createCompactor } from "./compactor.js";
import { DEFAULT_CORE_MEMORY_BLOCKS } from "./types.js";
import { supportsVector } from "@covel/store";
import { createVectorRecallSearcher } from "./vector-recall-search.js";
import { createVectorArchivalSearcher } from "./vector-archival-search.js";
import {
  createNoopIngestor,
  createVectorIngestor,
  type VectorIngestor,
} from "./vector-ingest.js";

export interface CreateMemorySystemOptions {
  readonly coreMemory?: CoreMemoryConfig;
  readonly updater?: MemoryUpdaterConfig;
  readonly compaction?: CompactionConfig;
}

/**
 * Create a fully wired memory system.
 *
 * Model slot resolution for the updater/compactor:
 *   explicit option (set by the bootstrap layer in production) → canonical
 *   "memory" slot → gateway default. See {@link resolveModelSlot}.
 *
 * Recall and archival default to **keyword** searchers (see recall-search.ts /
 * archival-search.ts). When `deps.embed` is injected and the store supports
 * vectors, they upgrade to **semantic (vector)** search with a per-session
 * keyword fallback, and {@link MemorySystem.ingest} becomes a real embed-on-
 * write path (see vector-ingest.ts). Both are constructed behind the
 * {@link RecallSearcher} / {@link ArchivalSearcher} interfaces, so callers are
 * unaffected by which implementation is wired.
 */
export function createMemorySystem(
  deps: MemorySystemDeps,
  options?: CreateMemorySystemOptions,
): MemorySystem {
  const { store, llm, resolveSlot } = deps;

  const explicitModelSlot =
    options?.updater?.modelSlot ?? options?.compaction?.modelSlot;
  const modelSlot = explicitModelSlot ?? resolveModelSlot(resolveSlot);

  // Single source of truth for the block schema across manager/updater/compactor
  // so post-turn extraction, rendering, and post-compaction refresh all agree.
  const blocks = options?.coreMemory?.blocks ?? DEFAULT_CORE_MEMORY_BLOCKS;

  const manager: MemoryManager = createMemoryManager(store, {
    ...options?.coreMemory,
    blocks,
  });

  const updaterInstance = createMemoryUpdater(manager, llm, {
    ...options?.updater,
    blocks,
    modelSlot,
  });

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
    ingestor = createVectorIngestor({ store, embed });
  } else {
    recall = keywordRecall;
    archival = keywordArchival;
    ingestor = createNoopIngestor();
  }

  const compactor = createCompactor(
    { store, llm, memoryManager: manager },
    { ...options?.compaction, blocks, modelSlot },
  );

  return {
    manager,
    updater: updaterInstance,
    recall,
    archival,

    async ingest(sessionId) {
      return ingestor.ingest(sessionId);
    },

    async compact(params): Promise<CompactionResult> {
      return compactor.compact(params);
    },
  };
}

/**
 * Canonical memory model slot name. The only slot this package probes by name —
 * all other slot routing is the bootstrap layer's responsibility, not the
 * memory package's.
 */
const MEMORY_SLOT = "memory";

/**
 * Standalone/test fallback slot resolution.
 *
 * Production never reaches this: the bootstrap layer always passes an explicit
 * `updater.modelSlot` (it resolves the preferred memory slot itself), so
 * `createMemorySystem` short-circuits on `explicitModelSlot`. This helper only
 * runs for a bare standalone boot or a test that omits the slot.
 *
 * It probes the single canonical `"memory"` slot; when that is unconfigured it
 * returns `undefined` and the updater/compactor fall back to the gateway's
 * default slot. No other slot names are hardcoded here — a prior `"story"`
 * fallback was removed because it baked an unrelated magic slot id into the
 * memory package (the gateway's own default-slot resolution covers that case).
 */
function resolveModelSlot(
  resolveSlot?: (slot: string) => string | undefined,
): string | undefined {
  if (!resolveSlot) return undefined;
  return resolveSlot(MEMORY_SLOT) ? MEMORY_SLOT : undefined;
}
