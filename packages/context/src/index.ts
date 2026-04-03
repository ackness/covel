// ── Store ──────────────────────────────────────────────────────────
export {
  createTurnContextStore,
  type TurnContextStore,
} from "./store/turn-context-store.js";

// ── Assembler ──────────────────────────────────────────────────────
export {
  assemblePrompt,
  buildContextView,
  type RuntimeInfo,
  type PromptAssemblerOptions,
  type AssembleInput,
} from "./assembler/prompt-assembler.js";

// ── Sections ───────────────────────────────────────────────────────
export {
  formatSection,
  formatPreviousOutputs,
} from "./sections/index.js";

// ── Compaction ────────────────────────────────────────────────────
export {
  compactChatHistory,
  needsCompaction,
  estimateTokens,
} from "./compaction/compactor.js";

export { buildRehydratedHistory } from "./compaction/rehydrator.js";

export type {
  CompactionConfig,
  CompactionResult,
  CompactionStats,
  CompactedChatHistory,
  RehydrationBundle,
} from "./compaction/types.js";

export { DEFAULT_COMPACTION_CONFIG } from "./compaction/types.js";

// ── Normalizer ────────────────────────────────────────────────────
export {
  normalizeMessages,
  type NormalizeOptions,
  type NormalizeProvider,
  type NormalizeResult,
  type RepairRecord,
} from "./normalizer/message-normalizer.js";

// ── Template ──────────────────────────────────────────────────────
export {
  loadPrompt,
  clearPromptCache,
  interpolate,
} from "./template/index.js";

// ── Types ──────────────────────────────────────────────────────────
export type {
  ProposalItem,
  RuntimeOutput,
  TurnContextInit,
  PromptResult,
  SectionMeta,
  ContextFragment,
} from "./types.js";
