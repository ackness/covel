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
const { problems, pairs } = checkPromptVariants({
  pluginsDir,
  lockPath: path.join(pluginsDir, "prompt-variants.lock.json"),
  write,
  requireChinese: true,
});

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
