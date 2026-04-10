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
