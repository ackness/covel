import fs from "node:fs/promises";
import path from "node:path";
import {
  instructionVariantCandidates,
  type PluginLanguages,
} from "@covel/shared";
import { readLocaleFiles } from "./locale-files.js";
import { manifestFilesOf } from "./locale-labels.js";

/** The language every plugin has: manifests, UI specs and prompts are English. */
const BASE = "en";

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The languages a plugin has text in, read from its files: a locale file
 * (the author's `locales/<locale>.yaml`, or one in the translations
 * directory) adds a language of labels and UI text, a `*.zh.md` beside a
 * manifest adds Chinese instructions.
 */
export async function pluginLanguages(
  pluginRoot: string,
): Promise<PluginLanguages> {
  // The author's files and the translations made outside the package: both
  // give the player text in that language.
  const translated = new Set(
    (await readLocaleFiles(pluginRoot)).map((file) => file.locale),
  );
  translated.delete(BASE);
  const text = [BASE, ...[...translated].sort()];
  let chinese = false;
  for (const manifest of await manifestFilesOf(pluginRoot)) {
    const stem = path.join(pluginRoot, manifest.replace(/\.md$/, ""));
    for (const tag of instructionVariantCandidates("zh-CN", "zh"))
      if (await exists(`${stem}.${tag}.md`)) chinese = true;
    if (chinese) break;
  }
  return { text, instructions: chinese ? [BASE, "zh"] : [BASE] };
}

/** One line for a validator or an install report. */
export function describePluginLanguages(languages: PluginLanguages): string {
  return `text ${languages.text.join(", ")}; instructions ${languages.instructions.join(", ")}`;
}
