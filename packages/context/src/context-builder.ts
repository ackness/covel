/**
 * Context Builder — assembles the execution context for a runtime.
 *
 * Responsibilities:
 * - Template variable interpolation ({{ inputs.xxx }}, {{ config.xxx }}, etc.)
 * - Inject block assembly (XML-wrapped data from other runtime outputs)
 * - Full context assembly (system prompt + message history)
 */

import type { AssembledContext, ContextBuildParams, LLMMessage } from './types.js';

/**
 * Resolve a dot-separated path against a nested object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(
  obj: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
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
export function interpolateTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(variables, path.trim());
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  });
}

/**
 * Extract the tag name from an XML-style tag string like `<narrator-output>`.
 */
function parseTagName(tag: string): string {
  return tag.replace(/^</, '').replace(/>$/, '');
}

/**
 * Build the inject XML blocks from input.inject declarations.
 *
 * For each inject declaration, finds the corresponding runtime result
 * and wraps the specified field value in the declared XML tag.
 */
export function buildInjectBlocks(
  params: ContextBuildParams,
): string {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) {
    return '';
  }

  const blocks: string[] = [];

  for (const inject of injects) {
    const result = params.completedResults.get(inject.from);
    if (!result?.output) {
      continue;
    }

    const value = result.output[inject.field];
    if (value === undefined || value === null) {
      continue;
    }

    const tagName = parseTagName(inject.as);
    blocks.push(`<${tagName}>${String(value)}</${tagName}>`);
  }

  return blocks.join('\n');
}

/**
 * Assemble the full execution context for a runtime.
 *
 * Combines the prompt template, inject blocks from upstream runtime outputs,
 * template variable interpolation, and message history into an `AssembledContext`
 * ready for LLM consumption.
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
  const { promptTemplate, turnInput, completedResults, config } = params;

  // Build inject blocks and append to prompt template
  const injectBlocks = buildInjectBlocks(params);
  const rawSystemPrompt = injectBlocks
    ? `${promptTemplate}\n${injectBlocks}`
    : promptTemplate;

  // Build the variables object for interpolation
  const inputsMap: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [key, result] of completedResults) {
    const [pluginId, runtimeId] = key.split('/');
    if (pluginId && runtimeId && result.output) {
      if (!inputsMap[pluginId]) {
        inputsMap[pluginId] = {};
      }
      inputsMap[pluginId][runtimeId] = result.output;
    }
  }

  // Build a `world` convenience object from config.world* keys so that
  // plugin templates can use `{{ world.lore }}`, `{{ world.dimensions }}`, etc.
  const world: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('world') && key.length > 5) {
      // worldLore → lore, worldDimensions → dimensions, worldEntries → entries, etc.
      const shortKey = key[5].toLowerCase() + key.slice(6);
      world[shortKey] = value;
    }
  }

  const variables: Record<string, unknown> = {
    inputs: inputsMap,
    config,
    ...config,
    world,
    session: {
      id: turnInput.sessionId,
    },
    player: {
      message: turnInput.playerMessage,
    },
  };

  // Interpolate template variables
  let systemPrompt = interpolateTemplate(rawSystemPrompt, variables);

  // Inject language constraint based on session locale
  if (turnInput.locale) {
    const langMap: Record<string, string> = {
      'zh-CN': '中文',
      'zh': '中文',
      'en-US': 'English',
      'en': 'English',
      'ja': '日本語',
      'ko': '한국어',
    };
    const langName = langMap[turnInput.locale] ?? turnInput.locale;
    systemPrompt += `\n\n[LANGUAGE] You MUST respond in ${langName}. All narrative output, tool parameters, and descriptions must be in ${langName}.`;
  }

  // Build messages: history + current user message
  const historyMessages: LLMMessage[] = (params.messageHistory ?? []).map(msg => ({
    role: msg.role as 'system' | 'user' | 'assistant',
    content: msg.content,
    ...(msg.name ? { name: msg.name } : {}),
  }));

  const messages: readonly LLMMessage[] = [
    ...historyMessages,
    { role: 'user', content: turnInput.playerMessage },
  ];

  return { systemPrompt, messages };
}
