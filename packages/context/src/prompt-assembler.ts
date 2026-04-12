/**
 * Three-tier Prompt Assembler V2 — infrastructure only (S2-T1).
 *
 * Implements the 10-segment assembly model described in
 * `devs/docs/insights/covel-improvement-plan.md` section A2:
 *
 * ```
 * [1 Framework Preamble]        ← session-stable header (locale, rules)
 * [2 Working Memory]            ← session-stable slow-vary (S3-T3)
 * [3 Plugin Instructions]       ← PLUGIN.md body, per-plugin stable
 * [4 WorldInfo: before-plugin]  ← keyword-triggered (S3-T1)
 * [5 Injects from upstream]     ← dynamic (this turn's upstream outputs)
 * [6 WorldInfo: after-plugin]   ← keyword-triggered (S3-T1)
 * ---- messages ----
 * [7 history (after pruning)]   ← dynamic (handled as messages)
 * [8 WorldInfo: at-depth:N]     ← placed before Nth-from-last message (S3-T1)
 * [9 Author's Note]             ← depth-4 instruction (S3-T4)
 * [10 Post-History Instructions]← director-grade high-weight (S3-T4)
 * ```
 *
 * **Scope for this ticket (S2-T1)**: only segments 1, 3, and 5 carry real
 * content. Segments 2, 4, 6, 8, 9, 10 return empty strings and are reserved
 * as wiring points for later tickets (S2-T3 cache_control, S3-T1 Lorebook,
 * S3-T3 Working Memory, S3-T4 Author's Note). Empty segments are skipped
 * during final concatenation so the output stays clean.
 *
 * The returned `AssembledContext.messages` array is unchanged from V1
 * (history + current user message). Budget pruning, when enabled, runs
 * on the V2 output exactly as it does on V1.
 *
 * Gated by `COVEL_PROMPT_V2=1`. When the flag is OFF, callers continue
 * hitting the V1 `buildContext` path and this module is not exercised.
 */

import { PROMPT_CACHE_BREAKPOINT_MARKER } from '@covel/shared';
import { applyBudget } from './budget.js';
import {
  assemblePromptVariables,
  buildInjectBlocks,
  interpolateTemplate,
  resolveLocaleLanguageName,
  renderWorkingMemory,
} from './prompt-internals.js';
import type { AssembledContext, ContextBuildParams, LLMMessage, MessageHistoryRecord, SummaryRecord } from './types.js';

// ── Summary substitution helper (mirrors context-builder.ts) ────

/**
 * V2 segment 7 — history with compaction substitution.
 * Same logic as the V1 helper in context-builder.ts. Keeping them in sync
 * is intentional: both paths must produce identical output for the same input.
 */
function buildMessageHistoryWithSummaries(
  messageHistory: readonly MessageHistoryRecord[],
  summaries: readonly SummaryRecord[],
): LLMMessage[] {
  const compactorEnabled = process.env.COVEL_COMPACTOR_V1 === '1';

  if (!compactorEnabled || summaries.length === 0) {
    return messageHistory.map(msg => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content,
      ...(msg.name ? { name: msg.name } : {}),
    }));
  }

  const summaryById = new Map(summaries.map(s => [s.id, s]));
  const emittedSummaryIds = new Set<string>();
  const result: LLMMessage[] = [];

  for (const msg of messageHistory) {
    const compactedId = (msg as MessageHistoryRecord & { compactedAtTurnId?: string }).compactedAtTurnId;

    if (compactedId) {
      if (!emittedSummaryIds.has(compactedId)) {
        const summary = summaryById.get(compactedId);
        if (summary) {
          emittedSummaryIds.add(compactedId);
          result.push({
            role: 'system',
            content: `[Compacted history: sections=${JSON.stringify(summary.focusSections)}]\n\n${summary.content}`,
          });
        }
      }
      continue;
    }

    result.push({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content,
      ...(msg.name ? { name: msg.name } : {}),
    });
  }

  return result;
}

/**
 * Structured view of the 10 system-prompt segments produced by V2.
 *
 * Only segments 1, 3, and 5 are populated in S2-T1. The remaining fields
 * are reserved placeholders; they always resolve to the empty string for
 * now and will gain real content in later tickets.
 */
export interface PromptSegments {
  /** Segment 1 — framework preamble (session-stable header). */
  readonly frameworkPreamble: string;
  /** Segment 2 — working memory (reserved for S3-T3). */
  readonly workingMemory: string;
  /** Segment 3 — interpolated PLUGIN.md body. */
  readonly pluginInstructions: string;
  /** Segment 4 — lorebook `before-plugin` position (reserved for S3-T1). */
  readonly worldInfoBeforePlugin: string;
  /** Segment 5 — upstream runtime injects (XML-wrapped). */
  readonly upstreamInjects: string;
  /** Segment 6 — lorebook `after-plugin` position (reserved for S3-T1). */
  readonly worldInfoAfterPlugin: string;
  /** Segment 8 — lorebook `at-depth` position (reserved for S3-T1). */
  readonly worldInfoAtDepth: string;
  /** Segment 9 — author's note (reserved for S3-T4). */
  readonly authorsNote: string;
  /** Segment 10 — post-history instructions (reserved for S3-T4). */
  readonly postHistoryInstructions: string;
}

/**
 * Build the default segment-1 framework preamble from the turn locale.
 *
 * Kept intentionally short — roughly two sentences — so it is cheap to
 * cache as the stable prefix of a prompt. When no locale is supplied the
 * preamble is empty and segment 1 is skipped during concatenation.
 *
 * Callers may override this entirely via `ContextBuildParams.frameworkPreamble`.
 */
function defaultFrameworkPreamble(locale: string | undefined): string {
  if (!locale) {
    return '';
  }
  const languageName = resolveLocaleLanguageName(locale);
  return `[LANGUAGE] You MUST respond in ${languageName}. All narrative output, tool parameters, and descriptions must be in ${languageName}.`;
}

/**
 * Build the 10 prompt segments for a single runtime context.
 *
 * Internal helper — exported only via {@link buildContextV2} so tests stay
 * focused on the public shape.
 */
function buildPromptSegments(params: ContextBuildParams): PromptSegments {
  const variables = assemblePromptVariables(params);

  const pluginInstructions = interpolateTemplate(
    params.promptTemplate,
    variables,
  );

  // Interpolate inject blocks too, mirroring V1 (which interpolates the
  // concatenated `template + injectBlocks` as one string). This keeps
  // behaviour consistent for plugins that reference template vars inside
  // injected output — an edge case, but cheap to preserve.
  const rawInjects = buildInjectBlocks(params);
  const upstreamInjects = rawInjects
    ? interpolateTemplate(rawInjects, variables)
    : '';

  const frameworkPreamble =
    params.frameworkPreamble ?? defaultFrameworkPreamble(params.turnInput.locale);

  // Segment 2 — Working Memory (S3-T3)
  const workingMemory = renderWorkingMemory(params.workingMemory);

  return {
    frameworkPreamble,
    workingMemory,
    pluginInstructions,
    worldInfoBeforePlugin: '',
    upstreamInjects,
    worldInfoAfterPlugin: '',
    worldInfoAtDepth: '',
    authorsNote: '',
    postHistoryInstructions: '',
  };
}

/**
 * Concatenate the pre-history segments (1–6) into a single system prompt.
 * Empty segments are skipped so there are no stray blank separators.
 *
 * When `injectCacheBreakpoints` is true (feature flag `COVEL_PROMPT_CACHE_V1=1`),
 * an invisible `PROMPT_CACHE_BREAKPOINT_MARKER` sentinel is appended to the
 * end of three cache-stable segments — framework preamble, plugin
 * instructions, and worldInfo-after-plugin. Provider adapters that support
 * explicit cache hints (currently Anthropic) split on these sentinels to
 * produce `cache_control: { type: 'ephemeral' }` breakpoints.
 *
 * Segment 2 (Working Memory) is intentionally **not** a breakpoint: per
 * §A15 of the improvement plan, WM is the "slow-vary" slice and placing
 * it outside the cache boundary prevents minor WM updates from invalidating
 * downstream cache hits.
 *
 * The marker is omitted for any segment that is empty so adapters never
 * see a degenerate zero-width breakpoint.
 */
function concatenateSystemPrompt(
  segments: PromptSegments,
  injectCacheBreakpoints: boolean,
): string {
  const parts: string[] = [];
  const markerForCacheable = injectCacheBreakpoints
    ? PROMPT_CACHE_BREAKPOINT_MARKER
    : '';

  if (segments.frameworkPreamble) {
    parts.push(segments.frameworkPreamble + markerForCacheable);
  }
  if (segments.workingMemory) parts.push(segments.workingMemory);
  if (segments.pluginInstructions) {
    parts.push(segments.pluginInstructions + markerForCacheable);
  }
  if (segments.worldInfoBeforePlugin) parts.push(segments.worldInfoBeforePlugin);
  if (segments.upstreamInjects) parts.push(segments.upstreamInjects);
  if (segments.worldInfoAfterPlugin) {
    parts.push(segments.worldInfoAfterPlugin + markerForCacheable);
  }
  return parts.join('\n\n');
}

/**
 * Read the S2-T3 prompt-cache feature flag lazily so tests can flip it per
 * case. Must be exactly the string `"1"` to enable — anything else
 * (undefined, `"0"`, `"true"`) keeps the pre-S2-T3 legacy path.
 */
function isPromptCacheEnabled(): boolean {
  return process.env.COVEL_PROMPT_CACHE_V1 === '1';
}

/**
 * Build the V2 assembled context. Same return shape as {@link buildContext}.
 *
 * Assembles the system prompt as 10 named segments (see {@link PromptSegments}),
 * then joins segments 1–6 with `\n\n` as the final `systemPrompt`. The
 * `messages` array is identical to V1: history + current user message.
 *
 * When the caller supplies both `estimator` and `contextBudget` AND
 * `COVEL_CONTEXT_BUDGET_V1=1` is set, the same pruning pass used by V1 runs
 * against the V2 output before returning.
 *
 * @param params - Same shape as `buildContext` with an optional
 *   `frameworkPreamble` override for segment 1.
 */
export function buildContextV2(
  params: ContextBuildParams,
): AssembledContext {
  const segments = buildPromptSegments(params);
  const systemPrompt = concatenateSystemPrompt(segments, isPromptCacheEnabled());

  // Segment 7: history with optional compaction substitution (S2-T2)
  const historyMessages: LLMMessage[] = buildMessageHistoryWithSummaries(
    params.messageHistory ?? [],
    params.summaries ?? [],
  );

  const messages: readonly LLMMessage[] = [
    ...historyMessages,
    { role: 'user', content: params.turnInput.playerMessage },
  ];

  const budgetEnabled =
    params.estimator !== undefined &&
    params.contextBudget !== undefined &&
    process.env.COVEL_CONTEXT_BUDGET_V1 === '1';

  if (budgetEnabled) {
    const result = applyBudget(systemPrompt, messages, {
      ...params.contextBudget!,
      estimator: params.estimator!,
    });
    return { systemPrompt, messages: result.messages };
  }

  return { systemPrompt, messages };
}
