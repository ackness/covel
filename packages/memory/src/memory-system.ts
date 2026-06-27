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
 * Recall and archival are **keyword** searchers (see recall-search.ts /
 * archival-search.ts — vector search is a documented follow-up, not yet
 * wired). They are constructed behind the {@link RecallSearcher} /
 * {@link ArchivalSearcher} interfaces, which are the swap seam for a future
 * vector implementation — see the note at the `recall`/`archival` site below.
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

  // Keyword searchers. EXTENSION POINT: to enable semantic (vector) recall,
  // swap these for vector-backed implementations behind the same
  // RecallSearcher / ArchivalSearcher interfaces. That requires two things the
  // codebase does not yet have: (1) an injected embed function (env keys are
  // available at bootstrap, so a `deps.embed` seam is the natural place), and
  // (2) an embed-on-write ingestion path that populates the store's per-session
  // vector tables — `searchVectors` exists but nothing fills the tables today.
  // Until both land, keyword search is the honest, dependency-free default and
  // works on every backend (including IdbStore, which has no vector capability).
  const recall: RecallSearcher = createKeywordRecallSearcher(store);
  const archival: ArchivalSearcher = createKeywordArchivalSearcher(store);

  const compactor = createCompactor(
    { store, llm, memoryManager: manager },
    { ...options?.compaction, blocks, modelSlot },
  );

  return {
    manager,
    updater: updaterInstance,
    recall,
    archival,

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
