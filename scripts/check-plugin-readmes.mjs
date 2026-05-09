#!/usr/bin/env node
/**
 * check-plugin-readmes — ensure each built-in plugin package has human-facing docs.
 *
 * PLUGIN.md is runtime input. README.md is for people: authors, maintainers,
 * and reviewers who need to understand the plugin without reading prompt text
 * as product documentation.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PLUGINS_DIR = resolve(REPO_ROOT, "plugins");

function pluginDirs(root) {
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .sort();
}

const dirs = pluginDirs(PLUGINS_DIR);
const missing = dirs.filter((dir) => !existsSync(join(dir, "README.md")));

if (missing.length > 0) {
  for (const dir of missing) {
    console.error(
      `${dir.replace(REPO_ROOT + "/", "")}: missing README.md for human/developer documentation`,
    );
  }
  console.error(`\ncheck-plugin-readmes: ${missing.length} missing README.md`);
  process.exit(1);
}

console.log(
  `check-plugin-readmes: OK (${dirs.length} plugin README file(s) scanned)`,
);
