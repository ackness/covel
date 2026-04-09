// ── Types ────────────────────────────────────────────────────────
export type {
  LLMMessage,
  AssembledContext,
  MessageHistoryRecord,
  ContextBuildParams,
} from './types.js';

// ── Context Builder ─────────────────────────────────────────────
export { interpolateTemplate, buildInjectBlocks, buildContext } from './context-builder.js';
