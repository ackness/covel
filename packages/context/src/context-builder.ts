/**
 * Context Builder — public entrypoint for runtime prompt assembly.
 *
 * Responsibilities:
 * - Template variable interpolation (`{{ inputs.xxx }}`, `{{ player.xxx }}`, etc.)
 * - Inject block assembly (XML-wrapped data from other runtime outputs)
 * - Full context assembly (system prompt + message history)
 *
 * Agent runtimes use one asynchronous entrypoint. The segment assembler lives
 * in `prompt-assembler.ts`.
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

/** Synchronous assembler used internally when no store read is needed. */
export function buildContextSync(params: ContextBuildParams): AssembledContext {
  return buildSegmentedContext(params);
}

/**
 * Determine whether a manifest requires the async build path.
 *
 * Returns `true` when the manifest declares at least one `input.inject`
 * entry with `kind: 'plugin-data'`.
 */
export function needsAsyncBuild(
  params: Pick<ContextBuildParams, "manifest">,
): boolean {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) return false;
  return injects.some((i) => (i as { kind?: string }).kind === "plugin-data");
}

/**
 * Internal path for `input.inject` entries of kind `plugin-data`, which
 * require a store round-trip to materialise.
 */
async function buildContextAsync(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  return buildSegmentedContextAsync(params);
}

/**
 * Assemble the full execution context for a runtime.
 *
 * Combines the prompt template, upstream injects, template interpolation,
 * and message history. Plugin-data injects read from `params.store`; other
 * inputs use the synchronous assembler. Budget pruning runs when both an
 * estimator and context budget are supplied.
 *
 * @example
 * ```typescript
 * import { buildContext } from '@covel/context';
 *
 * const ctx = await buildContext({
 *   promptTemplate: 'You are a narrator for {{ player.message }}',
 *   manifest,
 *   turnInput,
 *   completedResults: new Map(),
 * });
 * ```
 */
export async function buildContext(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  return needsAsyncBuild(params)
    ? buildContextAsync(params)
    : buildContextSync(params);
}
