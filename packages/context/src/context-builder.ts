/**
 * Context Builder — public entrypoint for runtime prompt assembly.
 *
 * Responsibilities:
 * - Template variable interpolation (`{{ inputs.xxx }}`, `{{ config.xxx }}`, etc.)
 * - Inject block assembly (XML-wrapped data from other runtime outputs)
 * - Full context assembly (system prompt + message history)
 *
 * The early-development codebase now uses one segment-based assembler for all
 * agent runtimes. `buildContext` remains the stable public API while the
 * implementation lives in `prompt-assembler.ts`.
 */

import {
  buildSegmentedContext,
  buildSegmentedContextAsync,
} from "./prompt-assembler.js";
import {
  buildInjectBlocks as _buildInjectBlocks,
  interpolateTemplate as _interpolateTemplate,
} from "./prompt-internals.js";
import type { AssembledContext, ContextBuildParams } from "./types.js";

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
 * This delegates to the segment-based assembler. Budget pruning runs whenever
 * the caller supplies both an estimator and context budget.
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
export function buildContext(params: ContextBuildParams): AssembledContext {
  return buildSegmentedContext(params);
}

/**
 * Determine whether a manifest requires the async build path.
 *
 * Returns `true` when the manifest declares at least one `input.inject`
 * entry with `kind: 'plugin-data'`. Callers use this to decide between
 * {@link buildContext} (sync) and {@link buildContextAsync} (async, supports
 * plugin-data inject).
 */
export function needsAsyncBuild(
  params: Pick<ContextBuildParams, "manifest">,
): boolean {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) return false;
  return injects.some((i) => (i as { kind?: string }).kind === "plugin-data");
}

/**
 * Async assembly path — semantically identical to {@link buildContext} but
 * supports `input.inject` entries of kind `plugin-data`, which require a
 * store round-trip to materialise.
 */
export async function buildContextAsync(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  return buildSegmentedContextAsync(params);
}
