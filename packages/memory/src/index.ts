/**
 * @covel/memory — Three-tier memory system for long-running game sessions.
 *
 * Inspired by Letta (MemGPT):
 *   - Core Memory Blocks: editable text in the context window
 *   - Recall Memory: searchable conversation history
 *   - Archival Memory: long-term cross-plugin knowledge
 *   - Compaction: automatic summarization of old messages
 *
 * Public surface is intentionally narrow: consumers compose the whole system
 * via `createMemorySystem`. The individual tier factories stay package-internal.
 */

// ── Types ────────────────────────────────────────────────────────
export type {
  CoreMemoryLabel,
  CoreMemoryBlockSchema,
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
} from "./types.js";

export { DEFAULT_CORE_MEMORY_BLOCKS } from "./types.js";

export type { EmbedFn } from "./vector-common.js";

// ── Memory system facade ─────────────────────────────────────────
export { createMemorySystem } from "./memory-system.js";
export type { CreateMemorySystemOptions } from "./memory-system.js";
