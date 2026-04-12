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

import type { AuthorsNoteDecl, PostHistoryDecl, RuntimeManifest } from '@covel/shared';
import { applyBudget } from './budget.js';
import {
  assemblePromptVariables,
  buildInjectBlocks,
  interpolateTemplate,
  resolveLocaleLanguageName,
  renderWorkingMemory,
} from './prompt-internals.js';
import type { AssembledContext, ContextBuildParams, LLMMessage, MessageHistoryRecord, SummaryRecord } from './types.js';

/** Default Author's Note insertion depth (SillyTavern default). */
const DEFAULT_AUTHORS_NOTE_DEPTH = 4;

/**
 * Aggregated Author's Note: one bundle produced by merging every active
 * plugin's `authorsNote` declaration. Notes that share the same role+depth
 * are concatenated into a single rendered message to keep the prompt compact.
 */
interface RenderedAuthorsNote {
  readonly role: 'system' | 'user' | 'assistant';
  readonly depth: number;
  readonly content: string;
}

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
 * Segments 1, 3, 5 carry the pre-history system prompt body. Segments 9 and
 * 10 are populated in S3-T4 and render as extra messages (not part of the
 * system prompt string). Remaining placeholders (2, 4, 6, 8) are reserved
 * for earlier tickets (S3-T1 Lorebook, S3-T3 Working Memory).
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
  /**
   * Segment 9 — Author's notes aggregated across active plugins (S3-T4).
   * Grouped by `(role, depth)`; each bundle is inserted before
   * `messages[length - depth]` as its own message.
   */
  readonly authorsNotes: readonly RenderedAuthorsNote[];
  /**
   * Segment 10 — Post-history instructions aggregated across active
   * plugins (S3-T4). One message per unique role, appended at the
   * very end of the message array.
   */
  readonly postHistoryInstructions: readonly LLMMessage[];
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
 * Resolve the priority-ordered list of manifests used for segment 9/10
 * aggregation. Defaults to the single current manifest when the caller
 * does not pass `activeManifests`.
 */
function resolveActiveManifests(params: ContextBuildParams): readonly RuntimeManifest[] {
  const fromCaller = params.activeManifests;
  if (!fromCaller || fromCaller.length === 0) {
    return [params.manifest];
  }
  // Stable sort by ascending priority — matches scheduler semantics
  // (0 = highest, runs first → renders first).
  return [...fromCaller].sort((a, b) => a.priority - b.priority);
}

/**
 * Collect all Author's Note declarations from the active manifests,
 * interpolate their content against the caller's variable bag, and group
 * them by `(role, depth)` so adjacent notes merge into a single message.
 */
function collectAuthorsNotes(
  manifests: readonly RuntimeManifest[],
  variables: Readonly<Record<string, unknown>>,
): readonly RenderedAuthorsNote[] {
  type Group = {
    readonly role: 'system' | 'user' | 'assistant';
    readonly depth: number;
    readonly lines: string[];
  };
  const groups: Group[] = [];

  for (const manifest of manifests) {
    const decl: AuthorsNoteDecl | undefined = manifest.authorsNote;
    if (!decl) continue;
    const rendered = interpolateTemplate(decl.content, variables).trim();
    if (!rendered) continue;

    const role = decl.role ?? 'system';
    const depth = decl.depth ?? DEFAULT_AUTHORS_NOTE_DEPTH;

    // Preserve declaration order within the same (role, depth) bucket.
    const existing = groups.find(g => g.role === role && g.depth === depth);
    if (existing) {
      existing.lines.push(rendered);
    } else {
      groups.push({ role, depth, lines: [rendered] });
    }
  }

  return groups.map(g => ({
    role: g.role,
    depth: g.depth,
    content: g.lines.join('\n\n'),
  }));
}

/**
 * Collect all Post-History Instruction declarations from the active
 * manifests and render them as a list of messages, one per unique role.
 * Notes sharing the same role are joined with a blank line.
 */
function collectPostHistoryInstructions(
  manifests: readonly RuntimeManifest[],
  variables: Readonly<Record<string, unknown>>,
): readonly LLMMessage[] {
  type Group = {
    readonly role: 'system' | 'user';
    readonly lines: string[];
  };
  const groups: Group[] = [];

  for (const manifest of manifests) {
    const decl: PostHistoryDecl | undefined = manifest.postHistory;
    if (!decl) continue;
    const rendered = interpolateTemplate(decl.content, variables).trim();
    if (!rendered) continue;

    const role = decl.role ?? 'system';
    const existing = groups.find(g => g.role === role);
    if (existing) {
      existing.lines.push(rendered);
    } else {
      groups.push({ role, lines: [rendered] });
    }
  }

  return groups.map(g => ({ role: g.role, content: g.lines.join('\n\n') }));
}

/**
 * Insert Author's Note bundles into a message array.
 *
 * Each bundle is placed before `messages[messages.length - depth]`. When
 * `depth <= 0` or `depth >= messages.length`, the bundle is appended at
 * the end (behaving like a post-history instruction). The returned array
 * is a new copy — the input is never mutated.
 */
function insertAuthorsNotes(
  messages: readonly LLMMessage[],
  notes: readonly RenderedAuthorsNote[],
): LLMMessage[] {
  if (notes.length === 0) return [...messages];

  // Work with an indexed array; each bundle converts to one LLMMessage that
  // we splice into the correct slot. Build all insertions first, then apply
  // from highest index to lowest so earlier splices don't shift later ones.
  const insertions: Array<{ index: number; message: LLMMessage }> = notes.map(note => {
    const message: LLMMessage = { role: note.role, content: note.content };
    const len = messages.length;
    let index: number;
    if (note.depth <= 0 || len === 0) {
      index = len;
    } else if (note.depth >= len) {
      index = 0;
    } else {
      index = len - note.depth;
    }
    return { index, message };
  });

  // Stable sort by insertion index descending; for equal indices, preserve
  // declaration order by reversing the tie-break so the final array shows
  // them in the original left-to-right order after splicing.
  const indexed = insertions.map((ins, order) => ({ ...ins, order }));
  indexed.sort((a, b) => b.index - a.index || b.order - a.order);

  const out: LLMMessage[] = [...messages];
  for (const ins of indexed) {
    out.splice(ins.index, 0, ins.message);
  }
  return out;
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

  // Segments 9 & 10 — Author's Note + Post-History Instructions (S3-T4).
  // Both segments aggregate across all active plugin manifests.
  const activeManifests = resolveActiveManifests(params);
  const authorsNotes = collectAuthorsNotes(activeManifests, variables);
  const postHistoryInstructions = collectPostHistoryInstructions(
    activeManifests,
    variables,
  );

  return {
    frameworkPreamble,
    workingMemory,
    pluginInstructions,
    worldInfoBeforePlugin: '',
    upstreamInjects,
    worldInfoAfterPlugin: '',
    worldInfoAtDepth: '',
    authorsNotes,
    postHistoryInstructions,
  };
}

/**
 * Concatenate the pre-history segments (1–6) into a single system prompt.
 * Empty segments are skipped so there are no stray blank separators.
 */
function concatenateSystemPrompt(segments: PromptSegments): string {
  const parts: string[] = [];
  if (segments.frameworkPreamble) parts.push(segments.frameworkPreamble);
  if (segments.workingMemory) parts.push(segments.workingMemory);
  if (segments.pluginInstructions) parts.push(segments.pluginInstructions);
  if (segments.worldInfoBeforePlugin) parts.push(segments.worldInfoBeforePlugin);
  if (segments.upstreamInjects) parts.push(segments.upstreamInjects);
  if (segments.worldInfoAfterPlugin) parts.push(segments.worldInfoAfterPlugin);
  return parts.join('\n\n');
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
  const systemPrompt = concatenateSystemPrompt(segments);

  // Segment 7: history with optional compaction substitution (S2-T2)
  const historyMessages: LLMMessage[] = buildMessageHistoryWithSummaries(
    params.messageHistory ?? [],
    params.summaries ?? [],
  );

  // Base chat: history + current user turn. Authors notes (segment 9) are
  // depth-positioned relative to this base, and post-history instructions
  // (segment 10) are appended after.
  const baseMessages: readonly LLMMessage[] = [
    ...historyMessages,
    { role: 'user', content: params.turnInput.playerMessage },
  ];

  // Segment 9 — insert author's notes at their declared depth.
  const withAuthorsNotes = insertAuthorsNotes(baseMessages, segments.authorsNotes);

  // Segment 10 — append post-history instructions after everything else.
  const messages: readonly LLMMessage[] = segments.postHistoryInstructions.length > 0
    ? [...withAuthorsNotes, ...segments.postHistoryInstructions]
    : withAuthorsNotes;

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
