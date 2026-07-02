/**
 * Segment-based Prompt Assembler.
 *
 * Implements the 10-segment assembly model:
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
 * [8 WorldInfo: at-depth:N]     ← placed before Nth-from-last message (depthContributions)
 * [9 Author's Note]             ← depth-4 instruction (S3-T4)
 * [10 Post-History Instructions]← director-grade high-weight (S3-T4)
 * ```
 *
 * Empty segments are skipped during final concatenation so the output stays
 * clean. The returned `AssembledContext.messages` array contains history,
 * the current user message, and any depth/post-history prompt contributions.
 */

import { applyBudget } from "./budget.js";
import {
  assemblePromptVariables,
  buildCurrentTurnUserMessage,
  buildFrameworkPreamble,
  buildInjectBlocks,
  buildInjectBlocksAsync,
  interpolateTemplate,
  renderCoreMemory,
  renderWorkingMemory,
} from "./prompt-internals.js";
import { serializeSystemPrompt } from "./prompt-serialization.js";
import {
  activeContributions,
  collectAuthorsNotes,
  collectDepthContributions,
  collectPostHistoryInstructions,
  renderSystemLoreContributions,
  renderSystemPersonaContributions,
  resolveActiveManifests,
} from "./contribution-aggregator.js";
import {
  buildMessageHistoryWithSummaries,
  insertAuthorsNotes,
  insertDepthContributions,
  type RenderedAuthorsNote,
  type RenderedDepthContribution,
} from "./message-insertion.js";
import type {
  AssembledContext,
  ContextBuildParams,
  LLMMessage,
} from "./types.js";

/**
 * Structured view of the system-prompt segments.
 *
 * Segments 1, 3, 5 carry the pre-history system prompt body; segments 4 and 6
 * carry lorebook `before-plugin` / `after-plugin` world info. Segments 9 and
 * 10 render as extra messages (not part of the system prompt string), as do
 * the at-depth (segment 8) contributions, which are inserted into the message
 * stack via {@link depthContributions} rather than the system prompt string.
 */
export interface PromptSegments {
  /** Segment 1 — framework preamble (session-stable header). */
  readonly frameworkPreamble: string;
  /** Segment 2 — core memory + working memory. */
  readonly workingMemory: string;
  /** Segment 3 — interpolated PLUGIN.md body (with persona prepend/append). */
  readonly pluginInstructions: string;
  /** Segment 4 — lorebook `before-plugin` position. */
  readonly worldInfoBeforePlugin: string;
  /** Segment 5 — upstream runtime injects (XML-wrapped). */
  readonly upstreamInjects: string;
  /** Segment 6 — lorebook `after-plugin` position. */
  readonly worldInfoAfterPlugin: string;
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
  readonly depthContributions: readonly RenderedDepthContribution[];
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
  return buildFrameworkPreamble(locale);
}

/**
 * Renders the session's event directory into a segment-5 XML block for
 * runtimes that opt in via `manifest.advertiseEvents: true`. Only the
 * emitting runtime pays for this — consumer-only runtimes never see it.
 *
 * Kept English-only (unlike the locale-branching `buildFrameworkPreamble`)
 * because `eventCatalogText` itself is already resolved to the session
 * locale by the event-directory service; this line is a fixed tool-use
 * instruction, not narrative-facing content.
 */
function buildAvailableEventsBlock(params: ContextBuildParams): string {
  if (params.manifest.advertiseEvents !== true) return "";
  const catalog = params.eventCatalogText;
  if (!catalog) return "";
  return (
    `<available-events>\n${catalog}\n\n` +
    "When a declared domain event occurs in your narration, call the emit-event tool — " +
    "one topic per call; tool calls are not part of the prose.\n</available-events>"
  );
}

/**
 * Build the 10 prompt segments for a single runtime context.
 *
 * Internal helper — used by the exported segmented context builder so tests
 * stay focused on the public shape.
 */
function buildPromptSegments(params: ContextBuildParams): PromptSegments {
  return buildPromptSegmentsCommon(params, buildInjectBlocks(params));
}

/**
 * Async variant — same as {@link buildPromptSegments} but resolves
 * `kind: 'plugin-data'` inject declarations via the injected store.
 */
async function buildPromptSegmentsAsync(
  params: ContextBuildParams,
): Promise<PromptSegments> {
  const rawInjects = await buildInjectBlocksAsync(params);
  return buildPromptSegmentsCommon(params, rawInjects);
}

/**
 * Shared segment assembly given a pre-resolved inject-block string. Split
 * out so the sync and async paths share every other segment unchanged.
 */
function buildPromptSegmentsCommon(
  params: ContextBuildParams,
  rawInjects: string,
): PromptSegments {
  const variables = assemblePromptVariables(params);

  const pluginInstructions = interpolateTemplate(
    params.promptTemplate,
    variables,
  );
  const contributions = activeContributions(params);
  const personaPrepend = renderSystemPersonaContributions(
    contributions,
    "seg3_prepend",
  );
  const personaAppend = renderSystemPersonaContributions(
    contributions,
    "seg3_append",
  );
  const worldInfoBeforePlugin = renderSystemLoreContributions(
    contributions,
    "before_plugin",
  );
  const worldInfoAfterPlugin = renderSystemLoreContributions(
    contributions,
    "after_plugin",
  );
  const pluginInstructionsWithPersona = [
    personaPrepend,
    pluginInstructions,
    personaAppend,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Interpolate inject blocks too so plugins may reference template variables
  // inside injected output.
  const interpolatedInjects = rawInjects
    ? interpolateTemplate(rawInjects, variables)
    : "";
  const upstreamInjects = [
    interpolatedInjects,
    buildAvailableEventsBlock(params),
  ]
    .filter(Boolean)
    .join("\n");

  const frameworkPreamble =
    params.frameworkPreamble ??
    defaultFrameworkPreamble(params.turnInput.locale);

  // Segment 2 — Core Memory (Letta-style) + Working Memory (S3-T3)
  const coreMemory = renderCoreMemory(
    params.coreMemoryBlocks,
    params.turnInput.locale,
  );
  const workingMemory = [coreMemory, renderWorkingMemory(params.workingMemory)]
    .filter(Boolean)
    .join("\n\n");

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
    pluginInstructions: pluginInstructionsWithPersona,
    worldInfoBeforePlugin,
    upstreamInjects,
    worldInfoAfterPlugin,
    authorsNotes,
    postHistoryInstructions,
    depthContributions: collectDepthContributions(contributions),
  };
}

/**
 * Build the assembled runtime context. Same return shape as
 * {@link buildContext}.
 *
 * Assembles the system prompt as 10 named segments (see {@link PromptSegments}),
 * then joins segments 1–6 with `\n\n` as the final `systemPrompt`. The
 * `messages` array contains history + current user message, with any
 * depth-positioned notes and post-history instructions applied afterward.
 *
 * When the caller supplies both `estimator` and `contextBudget`, the pruning
 * pass runs before returning.
 *
 * @param params - Same shape as `buildContext` with an optional
 *   `frameworkPreamble` override for segment 1.
 */
export function buildSegmentedContext(
  params: ContextBuildParams,
): AssembledContext {
  const segments = buildPromptSegments(params);
  return finalizeSegmentedContext(params, segments);
}

/**
 * Async assembly path — identical to {@link buildSegmentedContext} but uses
 * {@link buildPromptSegmentsAsync} so `kind: 'plugin-data'` injects can
 * await the store.
 */
export async function buildSegmentedContextAsync(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  const segments = await buildPromptSegmentsAsync(params);
  return finalizeSegmentedContext(params, segments);
}

/**
 * Shared finalisation — message history, author's notes, post-history
 * instructions, and budget pruning. Split out so the sync and async
 * paths share every post-segment step.
 */
function finalizeSegmentedContext(
  params: ContextBuildParams,
  segments: PromptSegments,
): AssembledContext {
  const systemPrompt = serializeSystemPrompt(segments, true);

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
    { role: "user", content: buildCurrentTurnUserMessage(params.turnInput) },
  ];

  // Segment 8/9 — insert depth-positioned persona/lore contributions at their
  // declared depth, then layer the author's notes on top.
  const withDepthContributions = insertDepthContributions(
    baseMessages,
    segments.depthContributions,
  );

  // Segment 9 — insert author's notes at their declared depth.
  const withAuthorsNotes = insertAuthorsNotes(
    withDepthContributions,
    segments.authorsNotes,
  );

  // Segment 10 — append post-history instructions after everything else.
  const messages: readonly LLMMessage[] =
    segments.postHistoryInstructions.length > 0
      ? [...withAuthorsNotes, ...segments.postHistoryInstructions]
      : withAuthorsNotes;

  const budgetEnabled =
    params.estimator !== undefined && params.contextBudget !== undefined;

  if (budgetEnabled) {
    const result = applyBudget(systemPrompt, messages, {
      ...params.contextBudget!,
      estimator: params.estimator!,
    });
    return { systemPrompt, messages: result.messages };
  }

  return { systemPrompt, messages };
}
