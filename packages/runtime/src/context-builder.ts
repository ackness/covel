/**
 * Context Builder — assembles the execution context for a runtime.
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
 * Replace template variables in a prompt template.
 *
 * Supported patterns:
 * - {{ inputs.pluginId.runtimeId.fieldName }} → other runtime's output field
 * - {{ config.fieldName }} → current runtime's config value
 * - {{ session.turnNumber }}, {{ session.id }} → session info
 * - {{ player.message }} → player's current message
 *
 * Unresolved variables are replaced with empty string.
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

  const variables: Record<string, unknown> = {
    inputs: inputsMap,
    config,
    // Spread config entries to top-level so {{ world.lore }} works alongside {{ config.x }}
    ...config,
    session: {
      id: turnInput.sessionId,
    },
    player: {
      message: turnInput.playerMessage,
    },
  };

  // Interpolate template variables
  const systemPrompt = interpolateTemplate(rawSystemPrompt, variables);

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
