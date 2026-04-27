// ── Types ────────────────────────────────────────────────────────
export type {
  LLMMessage,
  AssembledContext,
  MessageHistoryRecord,
  ContextBuildParams,
  SessionMeta,
  CharacterSummary,
  SummaryRecord,
  WorkingMemoryEntry,
} from './types.js';

// ── Context Builder ─────────────────────────────────────────────
export {
  interpolateTemplate,
  buildInjectBlocks,
  buildContext,
  buildContextAsync,
  needsAsyncBuild,
} from './context-builder.js';

// ── Prompt Assembler V2 (S2-T1) ─────────────────────────────────
export { buildContextV2, buildContextV2Async } from './prompt-assembler.js';
export type { PromptSegments } from './prompt-assembler.js';

// ── Token Budget ────────────────────────────────────────────────
export { applyBudget } from './budget.js';
export type { TokenEstimator, BudgetOptions, BudgetResult } from './budget.js';

// ── Prompt Loader ────────────────────────────────────────────────
export { loadPrompt, interpolate, setPromptsRoot } from './prompts-loader.js';

// ── Compactor (S2-T2) ────────────────────────────────────────────
export { maybeCompact } from './compactor.js';
export type {
  CompactorDeps,
  CompactorOptions,
  CompactorResult,
  CompactorLLMAdapter,
  CompactorRunner,
} from './compactor.js';

// ── Session Context Snapshot (Sprint 1) ──────────────────────────
export type {
  ContributionKind,
  ContextContribution,
  SessionContextSnapshot,
  WorldContextView,
  PersonaProfile,
  CoreMemoryBlockView,
  LorebookEntryView,
} from './types.js';

// ── Session Context Snapshot Loader (Sprint 1) ───────────────────
export { buildSessionContextSnapshot } from './session-context.js';
export type { BuildSessionContextSnapshotOpts } from './session-context.js';

// ── Narrow store interface (layering boundary) ──────────────────
export type { SessionContextStore } from './session-context-store.js';
