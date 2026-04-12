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

// ── Token Budget ────────────────────────────────────────────────
export { applyBudget } from './budget.js';
export type { TokenEstimator, BudgetOptions, BudgetResult } from './budget.js';
