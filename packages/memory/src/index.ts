/**
 * @covel/memory — Three-tier memory system for long-running game sessions.
 *
 * Inspired by Letta (MemGPT):
 *   - Core Memory Blocks: editable text in the context window
 *   - Recall Memory: searchable conversation history
 *   - Archival Memory: long-term cross-plugin knowledge
 *   - Compaction: automatic summarization of old messages
 */

// ── Types ────────────────────────────────────────────────────────
export type {
  CoreMemoryLabel,
  CoreMemoryLabelInfo,
  CoreMemoryBlock,
  CoreMemoryConfig,
  MemoryManager,
  MemoryLLMAdapter,
  MemoryUpdaterConfig,
  MemoryUpdateResult,
  MemoryUpdater,
  RecallSearchResult,
  RecallSearcher,
  ArchivalSearchResult,
  ArchivalSearcher,
  CompactionConfig,
  CompactionResult,
  MemorySystemDeps,
  MemorySystem,
} from './types.js';

export { CORE_MEMORY_LABELS, CORE_MEMORY_LABEL_INFO, DEFAULT_MAX_BLOCK_CHARS } from './types.js';

// ── Factories ────────────────────────────────────────────────────
export { createMemoryManager } from './core-memory.js';
export { createMemoryUpdater } from './updater.js';
export { createKeywordRecallSearcher } from './recall-search.js';
export { createKeywordArchivalSearcher } from './archival-search.js';
export { createCompactor } from './compactor.js';
export { createMemorySystem } from './memory-system.js';
export type { CreateMemorySystemOptions } from './memory-system.js';

// ── Renderers ────────────────────────────────────────────────────
export { renderCoreMemory, renderCompactedSummary } from './render.js';
