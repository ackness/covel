// ── Types ────────────────────────────────────────────────────────
export type {
  LLMMessage,
  AssembledContext,
  MessageHistoryRecord,
  ContextBuildParams,
  SessionMeta,
  CharacterSummary,
  SummaryRecord,
} from './types.js';

// ── Context Builder ─────────────────────────────────────────────
export { interpolateTemplate, buildInjectBlocks, buildContext } from './context-builder.js';

// ── Prompt Assembler V2 (S2-T1) ─────────────────────────────────
export { buildContextV2 } from './prompt-assembler.js';
export type { PromptSegments } from './prompt-assembler.js';

// ── Token Budget ────────────────────────────────────────────────
export { applyBudget } from './budget.js';
export type { TokenEstimator, BudgetOptions, BudgetResult } from './budget.js';

// ── Compactor (S2-T2) ────────────────────────────────────────────
export { maybeCompact } from './compactor.js';
export type {
  CompactorDeps,
  CompactorOptions,
  CompactorResult,
  CompactorLLMAdapter,
  CompactorRunner,
} from './compactor.js';
