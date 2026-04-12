/**
 * Prompt loader — read locale-aware markdown prompt templates from disk.
 *
 * This is the runtime backing for the "All LLM prompts are externalized as
 * locale-aware markdown files" convention documented in CLAUDE.md.
 *
 * Layout:
 *
 *   prompts/
 *     server/
 *       compactor.zh.md
 *       compactor.en.md
 *       generate-world.md      ← locale-less default
 *
 *     <plugin-id>/
 *       <name>.zh.md
 *       <name>.en.md
 *
 * Locale resolution order (matches the spec in CLAUDE.md):
 *   1. exact match           — `compactor.zh-CN.md`
 *   2. language fallback     — `compactor.zh.md`
 *   3. no-locale default     — `compactor.md`
 *   4. error                 — throws
 *
 * Templates use the same `{{ variable }}` syntax as `interpolateTemplate`.
 * The `interpolate` helper exported here is a thin shim that flattens a
 * `Record<string, string | number>` into the nested structure that
 * `interpolateTemplate` understands.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { interpolateTemplate } from './prompt-internals.js';

// ── Path resolution ─────────────────────────────────────────────

/**
 * Resolved root directory containing the `prompts/` tree.
 *
 * Strategy: walk upwards from this file's location until a directory that
 * contains a `prompts/` child is found. Cached after first lookup.
 *
 * The cache can be reset (and a custom root injected) via `setPromptsRoot`,
 * which is the seam tests use to point at fixtures.
 */
let promptsRootCache: string | null = null;

/**
 * Override the cached prompts root. Intended for tests and embedding scenarios
 * where the working directory differs from the monorepo layout.
 */
export function setPromptsRoot(root: string | null): void {
  promptsRootCache = root;
}

async function findPromptsRoot(): Promise<string> {
  if (promptsRootCache !== null) return promptsRootCache;

  // 1. Explicit env override (used by Docker / production deployments).
  const envOverride = process.env.COVEL_PROMPTS_DIR;
  if (envOverride) {
    promptsRootCache = path.resolve(envOverride);
    return promptsRootCache;
  }

  // 2. Walk upwards from this source file looking for a sibling `prompts/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  // Cap the walk so a misconfigured environment cannot loop forever.
  for (let i = 0; i < 16; i++) {
    const candidate = path.join(dir, 'prompts');
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        promptsRootCache = candidate;
        return promptsRootCache;
      }
    } catch {
      // not here, keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Fallback to CWD/prompts. Throws when actually used and missing.
  promptsRootCache = path.resolve(process.cwd(), 'prompts');
  return promptsRootCache;
}

// ── Locale handling ─────────────────────────────────────────────

/**
 * Build the ordered list of file basenames to try for the given locale.
 *
 * For `zh-CN`: `['<name>.zh-CN.md', '<name>.zh.md', '<name>.md']`
 * For `en-US`: `['<name>.en-US.md', '<name>.en.md', '<name>.md']`
 * For undefined locale: `['<name>.md']`
 */
function localeCandidates(name: string, locale?: string): string[] {
  if (!locale) return [`${name}.md`];

  const lang = locale.split('-')[0]!;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const candidate of [`${name}.${locale}.md`, `${name}.${lang}.md`, `${name}.md`]) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Load a prompt template from `prompts/<dir>/<name>.<locale>.md`.
 *
 * @param dir - Subdirectory under `prompts/` (e.g. `'server'`, plugin id).
 * @param name - File basename without extension or locale suffix.
 * @param locale - Locale tag like `'zh-CN'` or `'en-US'`. Optional.
 * @returns The raw markdown contents (UTF-8).
 *
 * @throws when no candidate file exists. The error message lists every path
 *         that was attempted so misconfigurations are easy to debug.
 *
 * @example
 * ```ts
 * const tpl = await loadPrompt('server', 'compactor', 'zh-CN');
 * const filled = interpolate(tpl, { sections: '关键事件\n- 人物关系' });
 * ```
 */
export async function loadPrompt(
  dir: string,
  name: string,
  locale?: string,
): Promise<string> {
  const root = await findPromptsRoot();
  const subDir = path.join(root, dir);
  const candidates = localeCandidates(name, locale);

  const tried: string[] = [];
  for (const filename of candidates) {
    const full = path.join(subDir, filename);
    tried.push(full);
    try {
      return await fs.readFile(full, 'utf8');
    } catch (err: unknown) {
      // ENOENT — keep trying. Anything else (permissions, etc.) bubbles up.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
  }

  throw new Error(
    `[loadPrompt] No prompt file found for dir="${dir}" name="${name}" locale="${locale ?? '(none)'}". ` +
    `Tried:\n  ${tried.join('\n  ')}`,
  );
}

/**
 * Interpolate `{{ key }}` placeholders in a template using a flat variable map.
 *
 * Thin shim over `interpolateTemplate` so callers don't need to nest their
 * variables under an arbitrary root key.
 *
 * @example
 * ```ts
 * interpolate('Hello {{ name }}', { name: 'world' }) // 'Hello world'
 * ```
 */
export function interpolate(
  template: string,
  variables: Readonly<Record<string, string | number>>,
): string {
  return interpolateTemplate(template, variables as Readonly<Record<string, unknown>>);
}
