#!/usr/bin/env node
/**
 * Check that every plugin prompt and its Chinese variant are in sync.
 *
 *   node scripts/check-prompt-variants.mjs            # check
 *   node scripts/check-prompt-variants.mjs --write    # record the current pairs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPromptVariants } from "./lib/prompt-variants.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginsDir = path.join(repoRoot, "plugins");
const write = process.argv.includes("--write");
const { problems, warnings, pairs } = checkPromptVariants({
  pluginsDir,
  lockPath: path.join(pluginsDir, "prompt-variants.lock.json"),
  write,
  requireChinese: true,
});
// A plugin made by `pnpm create-plugin` is a copy of a template, so the
// templates follow the same rules. They have no lock: nothing is paired.
const templates = checkPromptVariants({
  pluginsDir: path.join(repoRoot, "templates"),
});
problems.push(...templates.problems);
warnings.push(...templates.warnings);

// Style and structure findings are advice (docs/guide/prompt-style.md).
if (warnings.length > 0 && !write)
  console.warn(
    `[prompt-variants] ${warnings.length} style warning(s):\n${warnings.map((line) => `  - ${line}`).join("\n")}`,
  );

if (problems.length > 0) {
  console.error(
    `Prompt variant check failed:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  write
    ? `[prompt-variants] recorded ${Object.keys(pairs).length} pairs`
    : `[prompt-variants] ${Object.keys(pairs).length} pairs are in sync`,
);
