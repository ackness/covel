/**
 * Context Builder V1 — assembles the execution context for a runtime.
 *
 * Responsibilities:
 * - Template variable interpolation (`{{ inputs.xxx }}`, `{{ config.xxx }}`, etc.)
 * - Inject block assembly (XML-wrapped data from other runtime outputs)
 * - Full context assembly (system prompt + message history)
 *
 * V1 is the legacy single-pass assembler. When the environment variable
 * `COVEL_PROMPT_V2=1` is set, `buildContext` delegates to
 * {@link buildContextV2} (three-tier assembly, section A2 of the
 * improvement plan). With the flag unset the V1 path below is bit-identical
 * to its pre-S2-T1 behaviour.
 */

import { applyBudget } from './budget.js';
import { isEnvEnabled } from '@covel/shared';
import { buildContextV2, buildContextV2Async } from './prompt-assembler.js';
import {
  assemblePromptVariables,
  buildCurrentTurnUserMessage,
  buildInjectBlocks as _buildInjectBlocks,
  buildInjectBlocksAsync,
  interpolateTemplate as _interpolateTemplate,
  renderCoreMemory,
  renderWorkingMemory,
  resolveLocaleLanguageName,
} from './prompt-internals.js';
import type { AssembledContext, ContextBuildParams, LLMMessage, MessageHistoryRecord, SummaryRecord } from './types.js';

// ── Summary substitution helper (S2-T2 Compactor) ────────────────

/**
 * Build the LLM message history, substituting compacted message spans with
 * their summary when `COVEL_COMPACTOR_V1=1` is set.
 *
 * When the flag is off, this returns the original history verbatim (no
 * substitution), preserving byte-for-byte pre-ticket behaviour.
 *
 * Algorithm:
 * - Build a lookup map `summaryById`.
 * - Walk messages in order; the FIRST message whose `compactedAtTurnId` is set
 *   triggers a summary emit (as a `system` role message). Subsequent messages
 *   in the same compacted span are skipped. Once we encounter a message without
 *   `compactedAtTurnId` we resume normal emission.
 */
function buildMessageHistoryWithSummaries(
  messageHistory: readonly MessageHistoryRecord[],
  summaries: readonly SummaryRecord[],
): LLMMessage[] {
  const compactorEnabled = isEnvEnabled('COVEL_COMPACTOR_V1');

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
      // This message is compacted. Emit its summary once (on first encounter).
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
      // Skip the original compacted message regardless
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
 * Replace `{{ path }}` template variables in a prompt string.
 *
 * Supported variable paths:
 * - `{{ inputs.pluginId.runtimeId.fieldName }}` -- other runtime's output field
 * - `{{ config.fieldName }}` -- current runtime's config value
 * - `{{ session.id }}` -- session info
 * - `{{ player.message }}` -- player's current message
 *
 * Unresolved variables are replaced with an empty string.
 *
 * @param template - The prompt template containing `{{ variable }}` placeholders.
 * @param variables - A nested object of variable values to resolve against.
 * @returns The interpolated string with all placeholders replaced.
 *
 * @example
 * ```typescript
 * import { interpolateTemplate } from '@covel/context';
 *
 * const result = interpolateTemplate(
 *   'Hello {{ player.name }}, welcome to {{ world.name }}!',
 *   { player: { name: 'Aria' }, world: { name: 'Cloudmere' } },
 * );
 * // => 'Hello Aria, welcome to Cloudmere!'
 * ```
 */
export const interpolateTemplate = _interpolateTemplate;

/**
 * Build the inject XML blocks from `input.inject` declarations.
 *
 * For each inject declaration, finds the corresponding runtime result and
 * wraps the specified field value in the declared XML tag.
 */
export const buildInjectBlocks = _buildInjectBlocks;

/**
 * Assemble the full execution context for a runtime.
 *
 * Combines the prompt template, inject blocks from upstream runtime outputs,
 * template variable interpolation, and message history into an
 * `AssembledContext` ready for LLM consumption.
 *
 * When `COVEL_PROMPT_V2=1` is set, delegates to {@link buildContextV2}
 * (three-tier segment assembly). Otherwise runs the V1 single-pass logic.
 * Budget pruning (`COVEL_CONTEXT_BUDGET_V1=1`) applies to both paths.
 *
 * @param params - Context build parameters: prompt template, manifest, turn input, completed results, config, and message history.
 * @returns An `AssembledContext` containing the interpolated system prompt and ordered messages.
 *
 * @example
 * ```typescript
 * import { buildContext } from '@covel/context';
 *
 * const ctx = buildContext({
 *   promptTemplate: 'You are a narrator for {{ player.message }}',
 *   manifest,
 *   turnInput: { sessionId: 'sess-1', turnId: 'turn-1', playerMessage: 'Enter the dungeon' },
 *   completedResults: new Map(),
 *   config: {},
 * });
 *
 * console.log(ctx.systemPrompt); // Interpolated system prompt
 * console.log(ctx.messages);     // [{ role: 'user', content: 'Enter the dungeon' }]
 * ```
 */
export function buildContext(
  params: ContextBuildParams,
): AssembledContext {
  // V2 gate (S2-T1 + S2-T4 per-plugin opt-in).
  //
  // Routing requires BOTH:
  //   1. Environment flag `COVEL_PROMPT_V2=1` (deployment opt-in)
  //   2. Manifest `promptVersion === 2` (plugin opt-in)
  //
  // Either alone falls through to V1. This double gate lets operators roll
  // out V2 at the environment level while individual plugins migrate at
  // their own pace. See §A8 of `devs/docs/insights/covel-improvement-plan.md`.
  if (
    isEnvEnabled('COVEL_PROMPT_V2') &&
    params.manifest.promptVersion === 2
  ) {
    return buildContextV2(params);
  }

  const { promptTemplate, turnInput } = params;

  // Build inject blocks and append to prompt template
  const injectBlocks = _buildInjectBlocks(params);
  const rawSystemPrompt = injectBlocks
    ? `${promptTemplate}\n${injectBlocks}`
    : promptTemplate;

  // Assemble the variables object for interpolation (shared with V2).
  const variables = assemblePromptVariables(params);

  // Interpolate template variables
  let systemPrompt = _interpolateTemplate(rawSystemPrompt, variables);

  // Inject Core Memory blocks (Letta-style) — highest priority context
  const cmSegment = renderCoreMemory(params.coreMemoryBlocks, params.turnInput.locale);
  if (cmSegment) {
    systemPrompt = `${cmSegment}\n\n${systemPrompt}`;
  }

  // Inject Working Memory segment (S3-T3) — placed before other blocks
  const wmSegment = renderWorkingMemory(params.workingMemory);
  if (wmSegment) {
    systemPrompt = `${wmSegment}\n\n${systemPrompt}`;
  }

  // Inject language constraint based on session locale (V1 legacy: tail position).
  if (turnInput.locale) {
    const langName = resolveLocaleLanguageName(turnInput.locale);
    systemPrompt += `\n\n[LANGUAGE] You MUST respond in ${langName}. All narrative output, tool parameters, and descriptions must be in ${langName}.`;
  }

  // Build messages: history + current user message.
  // When COVEL_COMPACTOR_V1=1 is set, substitute compacted spans with their summary.
  const historyMessages: LLMMessage[] = buildMessageHistoryWithSummaries(
    params.messageHistory ?? [],
    params.summaries ?? [],
  );

  const messages: readonly LLMMessage[] = [
    ...historyMessages,
    { role: 'user', content: buildCurrentTurnUserMessage(turnInput) },
  ];

  // Conditional pruning gate — opt-in via feature flag + caller must supply
  // both an estimator and a budget config. Default behavior (flag unset) is
  // unchanged from the pre-S1-T2 semantics.
  const budgetEnabled =
    params.estimator !== undefined &&
    params.contextBudget !== undefined &&
    isEnvEnabled('COVEL_CONTEXT_BUDGET_V1');

  if (budgetEnabled) {
    const result = applyBudget(systemPrompt, messages, {
      ...params.contextBudget!,
      estimator: params.estimator!,
    });
    return { systemPrompt, messages: result.messages };
  }

  return { systemPrompt, messages };
}

/**
 * Determine whether a manifest requires the async build path.
 *
 * Returns `true` when the manifest declares at least one `input.inject`
 * entry with `kind: 'plugin-data'`. Callers use this to decide between
 * {@link buildContext} (sync, legacy) and {@link buildContextAsync}
 * (async, supports plugin-data inject). Manifests without plugin-data
 * injects stay on the sync path for zero-risk backward compatibility.
 */
export function needsAsyncBuild(params: Pick<ContextBuildParams, 'manifest'>): boolean {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) return false;
  return injects.some((i) => (i as { kind?: string }).kind === 'plugin-data');
}

/**
 * Async assembly path — semantically identical to {@link buildContext} but
 * supports `input.inject` entries of kind `plugin-data`, which require a
 * store round-trip to materialise.
 *
 * Routing rules mirror the sync path:
 *   - `COVEL_PROMPT_V2=1` + `manifest.promptVersion === 2` → V2 async
 *   - otherwise → V1 async
 *
 * The V1 async path is a drop-in copy of {@link buildContext} except it
 * `await`s the inject-block resolver. Keeping both paths around lets the
 * sync path (and all its tests) remain untouched during the rollout. Once
 * async is proven stable the sync helpers can be removed per OQ-4.
 */
export async function buildContextAsync(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  if (
    isEnvEnabled('COVEL_PROMPT_V2') &&
    params.manifest.promptVersion === 2
  ) {
    return buildContextV2Async(params);
  }

  const { promptTemplate, turnInput } = params;

  const injectBlocks = await buildInjectBlocksAsync(params);
  const rawSystemPrompt = injectBlocks
    ? `${promptTemplate}\n${injectBlocks}`
    : promptTemplate;

  const variables = assemblePromptVariables(params);
  let systemPrompt = _interpolateTemplate(rawSystemPrompt, variables);

  const cmSegment2 = renderCoreMemory(params.coreMemoryBlocks, turnInput.locale);
  if (cmSegment2) {
    systemPrompt = `${cmSegment2}\n\n${systemPrompt}`;
  }

  const wmSegment = renderWorkingMemory(params.workingMemory);
  if (wmSegment) {
    systemPrompt = `${wmSegment}\n\n${systemPrompt}`;
  }

  if (turnInput.locale) {
    const langName = resolveLocaleLanguageName(turnInput.locale);
    systemPrompt += `\n\n[LANGUAGE] You MUST respond in ${langName}. All narrative output, tool parameters, and descriptions must be in ${langName}.`;
  }

  const historyMessages: LLMMessage[] = buildMessageHistoryWithSummaries(
    params.messageHistory ?? [],
    params.summaries ?? [],
  );

  const messages: readonly LLMMessage[] = [
    ...historyMessages,
    { role: 'user', content: buildCurrentTurnUserMessage(turnInput) },
  ];

  const budgetEnabled =
    params.estimator !== undefined &&
    params.contextBudget !== undefined &&
    isEnvEnabled('COVEL_CONTEXT_BUDGET_V1');

  if (budgetEnabled) {
    const result = applyBudget(systemPrompt, messages, {
      ...params.contextBudget!,
      estimator: params.estimator!,
    });
    return { systemPrompt, messages: result.messages };
  }

  return { systemPrompt, messages };
}
