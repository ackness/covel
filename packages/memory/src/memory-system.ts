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
} from './types.js';
import { createMemoryManager } from './core-memory.js';
import { createMemoryUpdater } from './updater.js';
import { createKeywordRecallSearcher } from './recall-search.js';
import { createKeywordArchivalSearcher } from './archival-search.js';
import { createCompactor } from './compactor.js';

export interface CreateMemorySystemOptions {
  readonly coreMemory?: CoreMemoryConfig;
  readonly updater?: MemoryUpdaterConfig;
  readonly compaction?: CompactionConfig;
}

/**
 * Create a fully wired memory system.
 *
 * Model slot resolution for the updater/compactor:
 *   memory → story (no fast slot in current setup).
 */
export function createMemorySystem(
  deps: MemorySystemDeps,
  options?: CreateMemorySystemOptions,
): MemorySystem {
  const { store, llm, resolveSlot } = deps;

  // Resolve model slot: try "memory" first, fall back to "story"
  const modelSlot = resolveModelSlot(resolveSlot);

  const manager: MemoryManager = createMemoryManager(store, options?.coreMemory);

  const updaterInstance = createMemoryUpdater(manager, llm, {
    ...options?.updater,
    modelSlot,
  });

  const recall: RecallSearcher = createKeywordRecallSearcher(store);
  const archival: ArchivalSearcher = createKeywordArchivalSearcher(store);

  const compactor = createCompactor(
    { store, llm, memoryManager: manager },
    { ...options?.compaction, modelSlot },
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
 * Resolve model slot with fallback chain: memory → story → undefined.
 */
function resolveModelSlot(
  resolveSlot?: (slot: string) => string | undefined,
): string | undefined {
  if (!resolveSlot) return undefined;

  const memoryModel = resolveSlot('memory');
  if (memoryModel) return 'memory';

  const storyModel = resolveSlot('story');
  if (storyModel) return 'story';

  return undefined;
}
