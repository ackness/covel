// ── Types ────────────────────────────────────────────────────────
export type {
  LLMMessage,
  AssembledContext,
  MessageHistoryRecord,
  ContextBuildParams,
  SessionMeta,
  CharacterSummary,
  SummaryRecord,
  FrameworkCompletion,
  FrameworkCompletionContract,
} from "./types.js";

// ── Context Builder ─────────────────────────────────────────────
export {
  interpolateTemplate,
  buildInjectBlocks,
  buildContext,
  resolveFrameworkCompletion,
} from "./context-builder.js";

export { selectPromptSegments } from "./extension-segments.js";

// ── Token Budget ────────────────────────────────────────────────
export {
  DEFAULT_PROTECT_LAST_USER_TURNS,
  applyBudget,
  estimateTokens,
  flattenMessageContent,
  isCompactedHistoryEnvelope,
  resolveBudgetOptions,
} from "./budget.js";
export type {
  TokenEstimator,
  BudgetOptions,
  BudgetResult,
  ResolvedBudgetOptions,
} from "./budget.js";

// ── Prompt Loader ────────────────────────────────────────────────
export {
  loadPrompt,
  createPromptLoader,
  interpolate,
} from "./prompts-loader.js";
export type { PromptLoader } from "./prompts-loader.js";

// ── Compactor ────────────────────────────────────────────
export { maybeCompact } from "./history-budget.js";
export type {
  CompactorDeps,
  CompactorOptions,
  CompactorResult,
  CompactorRunner,
} from "./history-budget.js";

// ── Session Context Snapshot (Sprint 1) ──────────────────────────
export type {
  ContributionKind,
  ContextContribution,
  SessionContextSnapshot,
  WorldContextView,
  LorebookEntryView,
} from "./types.js";

export { WORLD_LORE_TOKEN_BUDGET, fitWorldLore } from "./world-lore.js";
export type { FittedWorldLore } from "./world-lore.js";

// ── Session Context Snapshot Loader (Sprint 1) ───────────────────
export { buildSessionContextSnapshot } from "./session-context.js";
export type { BuildSessionContextSnapshotOpts } from "./session-context.js";

// ── Branch Reply History Projection ─────────────────────────────

// ── Narrow store interface (layering boundary) ──────────────────
export type {
  SessionContextStore,
  SessionContextReadStore,
} from "./session-context-store.js";
