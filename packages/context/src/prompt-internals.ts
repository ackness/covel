/**
 * Shared prompt-assembly helpers used by both V1 (`context-builder.ts`) and
 * V2 (`prompt-assembler.ts`).
 *
 * Extracted so the two assemblers share one source of truth for:
 * - template-variable interpolation
 * - inject-block construction
 * - variable-object assembly (the big `variables` record fed to the
 *   interpolator, including `inputs`, `config`, `world`, `session`, `player`)
 * - locale → language-name resolution
 *
 * This module is `@internal` — exports are imported by sibling modules only
 * and are not re-exported from `src/index.ts`. Keeping them private to the
 * package prevents plugin code from reaching in and coupling to internals.
 */

import type { ContextBuildParams } from './types.js';

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
 * Unresolved variables are replaced with an empty string.
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

/** Extract the tag name from an XML-style tag string like `<narrator-output>`. */
function parseTagName(tag: string): string {
  return tag.replace(/^</, '').replace(/>$/, '');
}

/**
 * Build the inject XML blocks from `manifest.input.inject` declarations.
 *
 * For each inject declaration, find the corresponding runtime result and
 * wrap the specified field value in the declared XML tag.
 */
export function buildInjectBlocks(params: ContextBuildParams): string {
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
 * Assemble the full variables object consumed by `interpolateTemplate`.
 *
 * Mirrors the logic previously inlined in `buildContext`. Both V1 and V2
 * call this so the variable surface stays identical and plugin templates
 * see the same data regardless of which assembler is active.
 */
export function assemblePromptVariables(
  params: ContextBuildParams,
): Record<string, unknown> {
  const { turnInput, completedResults, config, sessionMeta } = params;

  // Build the `inputs` lookup map: pluginId → runtimeId → output.
  const inputsMap: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [key, result] of completedResults) {
    if (!result.output) continue;
    const slashIdx = key.indexOf('/');
    // Single-runtime: name = "core-narrator" → pluginId = runtimeId = "core-narrator"
    // Multi-runtime:  name = "core-world-init/schema-gen" → pluginId = "core-world-init", runtimeId = "schema-gen"
    const pluginId = slashIdx >= 0 ? key.slice(0, slashIdx) : key;
    const runtimeId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
    if (!inputsMap[pluginId]) {
      inputsMap[pluginId] = {};
    }
    inputsMap[pluginId][runtimeId] = result.output;
  }

  // Build a `world` convenience object from config.world* keys so plugin
  // templates can use `{{ world.lore }}`, `{{ world.dimensions }}`, etc.
  const world: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('world') && key.length > 5) {
      // worldLore → lore, worldDimensions → dimensions, worldEntries → entries, etc.
      const shortKey = key[5]!.toLowerCase() + key.slice(6);
      world[shortKey] = value;
    }
  }

  const playerChar = sessionMeta?.characters?.find(c => c.type === 'player') ?? null;

  // Stringify the latest form submission so template interpolation renders
  // a JSON blob (LLM-friendly) instead of "[object Object]".
  const lastFormValuesRaw = sessionMeta?.lastFormValues;
  const lastFormValuesStr =
    lastFormValuesRaw && Object.keys(lastFormValuesRaw).length > 0
      ? JSON.stringify(lastFormValuesRaw, null, 2)
      : '';

  return {
    inputs: inputsMap,
    config,
    ...config,
    world,
    session: {
      id: turnInput.sessionId,
      turnNumber: sessionMeta?.turnNumber ?? 0,
      phase: sessionMeta?.phase ?? 'unknown',
    },
    player: {
      message: turnInput.playerMessage,
      character: playerChar,
      lastFormValues: lastFormValuesStr,
      lastFormValuesRaw,
    },
  };
}

/**
 * Map a locale code (BCP-47) to a human-readable language name used in
 * the framework preamble. Falls back to the raw locale string if unknown.
 */
export function resolveLocaleLanguageName(locale: string): string {
  const langMap: Record<string, string> = {
    'zh-CN': '中文',
    'zh': '中文',
    'en-US': 'English',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
  };
  return langMap[locale] ?? locale;
}
