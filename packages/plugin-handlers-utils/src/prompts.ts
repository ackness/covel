import { promises as fs } from "node:fs";
import path from "node:path";
import { instructionVariantCandidates } from "./instruction-locale.js";
import { canonicalizeLocale } from "./locale-registry.js";

/**
 * Reads `<root>/<dir>/<name>.md` for a session. `locale` is the session's
 * content locale.
 */
export type PromptLoader = (
  dir: string,
  name: string,
  locale?: string,
) => Promise<string>;

/**
 * Files to try, most specific first. A plugin template is an instruction, so
 * it follows the rule of `PLUGIN.md` bodies: `<name>.md` is English, and only
 * a Simplified Chinese session (or `COVEL_INSTRUCTION_LOCALE=zh`) reads a
 * `<name>.zh.md` variant. Files in any other language are never read.
 */
function instructionCandidates(name: string, locale?: string): string[] {
  if (locale !== undefined && !canonicalizeLocale(locale)) {
    throw new Error(`[loadPrompt] Invalid locale: ${JSON.stringify(locale)}`);
  }
  return [
    ...instructionVariantCandidates(locale).map(
      (candidate) => `${name}.${candidate}.md`,
    ),
    `${name}.md`,
  ];
}

/** A loader for a plugin's own prompt templates under `root`. */
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
  for (const filename of instructionCandidates(name, locale)) {
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
