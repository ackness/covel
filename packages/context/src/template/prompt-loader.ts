import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * Extract the language prefix from a locale string.
 * "zh-CN" → "zh", "en-US" → "en", "ja" → "ja"
 */
function langPrefix(locale: string): string {
  return locale.split("-")[0];
}

/**
 * Check if a file exists without throwing.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a locale-aware prompt template from a directory.
 *
 * Resolution order:
 *   1. `<name>.<lang>.md`  (exact language match, e.g. rules.zh.md)
 *   2. `<name>.en.md`      (English fallback)
 *   3. `<name>.md`         (no-locale default)
 *   4. Error
 *
 * Results are cached in memory. Use `clearPromptCache()` to reset.
 */
export async function loadPrompt(
  dir: string,
  name: string,
  locale: string,
): Promise<string> {
  const lang = langPrefix(locale);
  const cacheKey = `${dir}/${name}:${lang}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const candidates = [
    join(dir, `${name}.${lang}.md`),
    ...(lang !== "en" ? [join(dir, `${name}.en.md`)] : []),
    join(dir, `${name}.md`),
  ];

  for (const path of candidates) {
    if (await fileExists(path)) {
      const content = (await readFile(path, "utf-8")).trim();
      cache.set(cacheKey, content);
      return content;
    }
  }

  throw new Error(
    `Prompt template not found: ${name} (locale: ${locale}, dir: ${dir})`,
  );
}

/**
 * Clear the prompt cache. Used in tests.
 */
export function clearPromptCache(): void {
  cache.clear();
}
