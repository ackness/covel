/**
 * Prompt loader — read locale-aware markdown prompt templates from disk.
 *
 * This is the runtime backing for the "All LLM prompts are externalized as
 * locale-aware markdown files" convention documented in AGENTS.md.
 *
 * Layout:
 *
 *   prompts/
 *     server/
 *       generate-world.md      ← locale-less default
 *       repair-world-lore.md   ← locale-less default
 *
 * A locale file such as `generate-world.zh.md` next to a default takes over for
 * that locale (see the resolution order below). Plugin prompts are not kept
 * here: a plugin package keeps its own prompt files.
 *
 * Locale resolution order (matches the spec in AGENTS.md):
 *   1. exact match           — `compactor.zh-CN.md`
 *   2. language fallback     — `compactor.zh.md`
 *   3. registry fallback     — `compactor.en-US.md` / `compactor.en.md`
 *   4. no-locale default     — `compactor.md`
 *   5. error                 — throws
 *
 * Templates use the same `{{ variable }}` syntax as `interpolateTemplate`.
 * The `interpolate` helper exported here is a thin shim that flattens a
 * `Record<string, string | number>` into the nested structure that
 * `interpolateTemplate` understands.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeLocale,
  localeLookupCandidates,
  localeRegistry,
  readRuntimeEnv,
} from "@covel/shared";

export { interpolate } from "@covel/plugin-handlers-utils";

/** Locale-aware template source, injectable into prompt consumers. */
export type PromptLoader = (
  dir: string,
  name: string,
  locale?: string,
) => Promise<string>;

/**
 * Framework templates (`prompts/`) are looked up for any locale: the exact
 * locale, its language, the registry fallback (English), then the
 * locale-less file. Plugin templates follow the stricter instruction rule of
 * `createPromptLoader` in `@covel/plugin-handlers-utils/prompts`.
 */
function localeCandidates(name: string, locale?: string): string[] {
  if (!locale) return [`${name}.md`];

  const canonicalLocale = canonicalizeLocale(locale);
  if (!canonicalLocale) {
    throw new Error(`[loadPrompt] Invalid locale: ${JSON.stringify(locale)}`);
  }

  const locales = [
    canonicalLocale,
    ...localeRegistry.fallbackLocalesFor(canonicalLocale),
  ];
  const candidates = locales.flatMap((candidateLocale) =>
    localeLookupCandidates(candidateLocale).map(
      (candidate) => `${name}.${candidate}.md`,
    ),
  );
  candidates.push(`${name}.md`);
  return [...new Set(candidates)];
}

/** A loader for the framework templates under `root`. */
export function createPromptLoader(root: string): PromptLoader {
  const resolvedRoot = path.resolve(root);
  return (dir, name, locale) =>
    loadPromptFromRoot(resolvedRoot, dir, name, locale);
}

async function loadPromptFromRoot(
  root: string,
  dir: string,
  name: string,
  locale?: string,
): Promise<string> {
  const subDir = path.join(root, dir);
  const tried: string[] = [];
  for (const filename of localeCandidates(name, locale)) {
    const full = path.join(subDir, filename);
    tried.push(full);
    try {
      return await fs.readFile(full, "utf8");
    } catch (err: unknown) {
      // ENOENT — keep trying. Anything else (permissions, etc.) bubbles up.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  }

  throw new Error(
    `[loadPrompt] No prompt file found for dir="${dir}" name="${name}" locale="${locale ?? "(none)"}". ` +
      `Tried:\n  ${tried.join("\n  ")}`,
  );
}

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
 * Override the default loader's cached root for the whole process.
 * Use `createPromptLoader` for independent consumers or concurrent tests.
 */
export function setPromptsRoot(root: string | null): void {
  promptsRootCache = root;
}

async function findPromptsRoot(): Promise<string> {
  if (promptsRootCache !== null) return promptsRootCache;

  // 1. Explicit env override (used by Docker / production deployments).
  const envOverride = readRuntimeEnv().promptsDir;
  if (envOverride) {
    promptsRootCache = path.resolve(envOverride);
    return promptsRootCache;
  }

  // 2. Walk upwards from this source file looking for a sibling `prompts/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  // Cap the walk so a misconfigured environment cannot loop forever.
  for (let i = 0; i < 16; i++) {
    const candidate = path.join(dir, "prompts");
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
  promptsRootCache = path.resolve(process.cwd(), "prompts");
  return promptsRootCache;
}

// ── Locale handling ─────────────────────────────────────────────

/**
 * Build the ordered list of file basenames to try for the given locale.
 *
 * For `zh-CN`: exact, language, registry fallbacks, then canonical default.
 * For `ru-RU`: `ru-RU`, `ru`, `en-US`, `en`, then the locale-less default.
 * For undefined locale: `['<name>.md']`
 */
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
  return createPromptLoader(await findPromptsRoot())(dir, name, locale);
}
