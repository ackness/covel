import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canonicalizeLocale,
  localeLookupCandidates,
  localeRegistry,
} from "./locale-registry.js";

export type PromptLoader = (
  dir: string,
  name: string,
  locale?: string,
) => Promise<string>;

function localeCandidates(name: string, locale?: string): string[] {
  if (!locale) return [`${name}.md`];

  const canonicalLocale = canonicalizeLocale(locale);
  if (!canonicalLocale) {
    throw new Error(`[loadPrompt] Invalid locale: ${JSON.stringify(locale)}`);
  }

  const seen = new Set<string>();
  const out: string[] = [];

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

  for (const candidate of candidates) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

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
  const candidates = localeCandidates(name, locale);

  const tried: string[] = [];
  for (const filename of candidates) {
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
