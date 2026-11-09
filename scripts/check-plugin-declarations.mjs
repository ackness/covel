#!/usr/bin/env node
/**
 * check-plugin-declarations — bundled plugins keep `contributes` in sync with
 * what their entry registers (`pnpm plugin:extract <dir> --check`, for all of
 * them in one process).
 *
 * Unlike `validate:plugin`, this EXECUTES each entry factory, so it only runs
 * on bundled plugins, which are trusted repository code that the server tests
 * already load. Handlers never run; extraction only records registrations.
 * Run with `node --import tsx`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPlainYamlFrontmatter } from "../packages/plugin-loader/src/plain-yaml-frontmatter.ts";
import { rewriteContributes } from "../packages/plugin-loader/src/rewrite-contributes.ts";
import { extractDeclarations } from "../packages/test-runtime/src/extract-declarations.ts";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ENTRY = "./server/index.js";

/** A plugin with no entry registers nothing, so there is nothing to sync. */
function hasEntry(dir) {
  const { data } = readPlainYamlFrontmatter(
    readFileSync(path.join(dir, "PLUGIN.md"), "utf8"),
  );
  return (
    typeof data.entry === "string" || existsSync(path.join(dir, DEFAULT_ENTRY))
  );
}

/** Returns one problem text per out-of-sync or failing plugin. */
export async function checkPluginDeclarations(repoRoot = defaultRoot) {
  const pluginDir = path.join(repoRoot, "plugins");
  const plugins = readdirSync(pluginDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        existsSync(path.join(pluginDir, entry.name, "PLUGIN.md")),
    )
    .map((entry) => path.join(pluginDir, entry.name))
    .sort();
  const problems = [];
  let checked = 0;
  for (const dir of plugins) {
    const label = path.relative(repoRoot, dir).split(path.sep).join("/");
    try {
      if (!hasEntry(dir)) continue;
      checked += 1;
      const extracted = await extractDeclarations(dir);
      const { drift } = rewriteContributes(
        readFileSync(path.join(dir, "PLUGIN.md"), "utf8"),
        extracted,
      );
      if (drift.length === 0) continue;
      const lines = drift.flatMap(({ key, added, removed }) => [
        `  contributes.${key}:`,
        ...removed.map((name) => `    - ${name} (declared, not registered)`),
        ...added.map((name) => `    + ${name} (registered, not declared)`),
        ...(added.length || removed.length
          ? []
          : ["    ~ order or declaration shape changed"]),
      ]);
      problems.push(
        `${label}: PLUGIN.md contributes is out of sync with the entry\n${lines.join("\n")}\n  Fix: pnpm plugin:extract ${label}`,
      );
    } catch (error) {
      problems.push(
        `${label}: cannot extract registrations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { checked, problems };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag > 0 ? path.resolve(process.argv[rootFlag + 1]) : defaultRoot;
  const { checked, problems } = await checkPluginDeclarations(root);
  if (problems.length > 0) {
    console.error(problems.join("\n\n"));
    console.error(
      `\ncheck-plugin-declarations: ${problems.length} of ${checked} plugins need attention`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Bundled plugin declarations match their entries (${checked} checked).`,
    );
  }
}
