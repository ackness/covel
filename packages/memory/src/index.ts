/** Kernel recall, archival search, and vector ingestion primitives. */
export type {
  RecallSearchResult,
  RecallSearcher,
  ArchivalSearchResult,
  ArchivalSearcher,
  MemorySystemDeps,
  MemorySystem,
} from "./types.js";
export type { EmbedFn } from "./vector-common.js";
export type { MemoryBackgroundDrainResult } from "./background-tasks.js";
export { createMemorySystem } from "./memory-system.js";
export type {
  MemoryStore,
  RecallStore,
  ArchivalStore,
  VectorIngestStore,
} from "./store-contracts.js";
