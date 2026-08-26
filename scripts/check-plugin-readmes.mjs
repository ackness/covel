#!/usr/bin/env node
/**
 * check-plugin-readmes — ensure each built-in plugin package has human-facing docs.
 *
 * PLUGIN.md is runtime input. README.md is for people: authors, maintainers,
 * and reviewers who need to understand the plugin without reading prompt text
 * as product documentation.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PLUGINS_DIR = resolve(REPO_ROOT, "plugins");
const TEMPLATES_DIR = resolve(REPO_ROOT, "templates");
const PLACEHOLDER_REGEX = /\{\{[^}]+\}\}/;

function childDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .sort();
}

// Package managers can leave ignored `node_modules`-only directories after a
// plugin is moved or archived. A real built-in plugin package has a manifest
// or package.json; residue must not create a false missing-README failure.
const pluginDirsToCheck = childDirs(PLUGINS_DIR).filter(
  (dir) =>
    existsSync(join(dir, "PLUGIN.md")) || existsSync(join(dir, "package.json")),
);
const missing = pluginDirsToCheck.filter(
  (dir) => !existsSync(join(dir, "README.md")),
);
const templateDirsToCheck = childDirs(TEMPLATES_DIR);
const templateReadmesToCheck = templateDirsToCheck
  .map((dir) => join(dir, "README.md"))
  .filter((file) => existsSync(file));
const unresolvedTemplateReadmes = templateReadmesToCheck.filter(
  (file) => !PLACEHOLDER_REGEX.test(readFileSync(file, "utf8")),
);

if (missing.length > 0) {
  for (const dir of missing) {
    console.error(
      `${relative(REPO_ROOT, dir)}: missing README.md for human/developer documentation`,
    );
  }
  console.error(`\ncheck-plugin-readmes: ${missing.length} missing README.md`);
  process.exit(1);
}

if (unresolvedTemplateReadmes.length > 0) {
  for (const file of unresolvedTemplateReadmes) {
    console.error(
      `${relative(REPO_ROOT, file)}: template README.md has no {{...}} placeholder; generated plugins may keep template prose unchanged`,
    );
  }
  console.error(
    `\ncheck-plugin-readmes: ${unresolvedTemplateReadmes.length} template README.md file(s) without placeholders`,
  );
  process.exit(1);
}

console.log(
  `check-plugin-readmes: OK (${pluginDirsToCheck.length} plugin README file(s), ${templateReadmesToCheck.length} template README file(s) scanned)`,
);
