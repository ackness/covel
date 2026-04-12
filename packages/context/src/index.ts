// ── Types ────────────────────────────────────────────────────────
export type {
  LLMMessage,
  AssembledContext,
  MessageHistoryRecord,
  ContextBuildParams,
  SessionMeta,
  CharacterSummary,
} from './types.js';

// ── Context Builder ─────────────────────────────────────────────
export { interpolateTemplate, buildInjectBlocks, buildContext } from './context-builder.js';

// ── Prompt Assembler V2 (S2-T1) ─────────────────────────────────
export { buildContextV2 } from './prompt-assembler.js';
export type { PromptSegments } from './prompt-assembler.js';

// ── Token Budget ────────────────────────────────────────────────
export { applyBudget } from './budget.js';
export type { TokenEstimator, BudgetOptions, BudgetResult } from './budget.js';
