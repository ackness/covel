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
 * Build the current-turn user message passed to the LLM.
 *
 * Empty player input commonly happens on framework-driven turns such as
 * `start_session`. In that case we supply a compact execution cue so models
 * stay inside the runtime task instead of drifting into assistant small talk.
 */
export function buildCurrentTurnUserMessage(
  turnInput: Pick<ContextBuildParams['turnInput'], 'playerMessage' | 'locale'>,
): string {
  if (turnInput.playerMessage.trim().length > 0) {
    return turnInput.playerMessage;
  }

  const locale = turnInput.locale ?? '';
  if (locale === 'zh' || locale.startsWith('zh-')) {
    return '开始当前游戏回合，并按照系统设定直接给出游戏内结果。';
  }

  return 'Begin the current game turn and produce the in-game result defined by the system instructions.';
}

/**
 * Framework preamble used by V2 prompt assembly (segment 1).
 *
 * When a locale is provided, prepends a `[RUNTIME]` header that keeps
 * task-general assistants from drifting outside the interactive-narrative
 * frame, then appends the `[LANGUAGE]` constraint. When no locale is
 * supplied this returns an empty string so segment 1 is skipped — preserving
 * V1/V2 byte-identity in the locale-less baseline.
 */
export function buildFrameworkPreamble(locale?: string): string {
  if (!locale) {
    return '';
  }

  const languageName = resolveLocaleLanguageName(locale);
  return [
    '[RUNTIME] You are executing an in-game runtime for an interactive narrative engine.',
    '[RUNTIME] Follow the runtime instructions and world data below as the complete task context.',
    '[RUNTIME] Produce only in-world narrative, structured runtime output, and required tool calls.',
    `[LANGUAGE] You MUST respond in ${languageName}. All narrative output, tool parameters, and descriptions must be in ${languageName}.`,
  ].join('\n');
}

/**
 * Render Working Memory entries as a prompt segment (S3-T3).
 *
 * Sorting is deterministic: scope order `player` → `story` → `shared`,
 * then alphabetical key within scope. If no entries exist, returns an
 * empty string so callers can skip the segment.
 *
 * Gated by `COVEL_WORKING_MEMORY_V1=1`. When unset, returns empty string
 * unconditionally so the feature has zero overhead when disabled.
 */
export function renderWorkingMemory(
  entries: readonly { scope: 'player' | 'story' | 'shared'; key: string; value: unknown }[] | undefined,
): string {
  if (process.env.COVEL_WORKING_MEMORY_V1 !== '1') {
    return '';
  }
  if (!entries || entries.length === 0) {
    return '';
  }

  const scopeOrder: Record<string, number> = { player: 0, story: 1, shared: 2 };
  const sorted = [...entries].sort((a, b) => {
    const scopeDiff = (scopeOrder[a.scope] ?? 99) - (scopeOrder[b.scope] ?? 99);
    if (scopeDiff !== 0) return scopeDiff;
    return a.key.localeCompare(b.key);
  });

  const lines = sorted.map((entry) => {
    const valueStr = typeof entry.value === 'string'
      ? JSON.stringify(entry.value)
      : JSON.stringify(entry.value);
    return `${entry.scope}.${entry.key}: ${valueStr}`;
  });

  return `[Working Memory]\n${lines.join('\n')}`;
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
