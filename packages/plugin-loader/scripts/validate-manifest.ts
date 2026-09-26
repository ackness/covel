#!/usr/bin/env tsx
/**
 * Validate PLUGIN.md manifests from the command line.
 *
 * Usage:
 *   pnpm validate:plugin <path...>
 *
 * A path may be a PLUGIN.md file or a plugin directory (validates the root
 * PLUGIN.md if present plus every runtimes/<sub>/PLUGIN.md).
 *
 * Two passes per file:
 *  1. `parsePluginMd` — the loader's parse (I18nText description
 *     folding, lenient-field handling, line-numbered errors). This is what
 *     decides whether the plugin LOADS.
 *  2. `runtimeManifestAuthoringSchema` — the strict authoring target: every
 *     cross-field constraint enforced, including a required stage on
 *     auto/scheduled runtimes. Validate the raw frontmatter so normalization
 *     cannot hide an invalid declaration from authors.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validatePluginDeclarations } from "../src/declarations.js";
import type { ParsedPluginMd } from "../src/types.js";
import { parsePluginMd } from "../src/parse-plugin-md.js";
import {
  hasRuntimeDeclaration,
  multiRuntimeRootDiagnostics,
} from "../src/root-manifest-diagnostics.js";
import { runtimeManifestAuthoringSchema } from "@covel/shared";

const args = process.argv.slice(2);
const paths = args;

if (paths.length === 0 || args.some((arg) => arg.startsWith("--"))) {
  console.error("Usage: pnpm validate:plugin <PLUGIN.md | plugin-dir>...");
  process.exit(2);
}

function collectManifestFiles(path: string): string[] {
  if (!existsSync(path)) {
    console.error(`✗ ${path}: no such file or directory`);
    process.exitCode = 1;
    return [];
  }
  if (statSync(path).isFile()) {
    if (basename(path) === "PLUGIN.md") {
      const parent = dirname(path);
      if (basename(dirname(parent)) === "runtimes") {
        return collectManifestFiles(dirname(dirname(parent)));
      }
      if (existsSync(join(parent, "runtimes"))) {
        return collectManifestFiles(parent);
      }
    }
    return [path];
  }
  const files: string[] = [];
  const rootMd = join(path, "PLUGIN.md");
  if (existsSync(rootMd)) files.push(rootMd);
  const runtimesDir = join(path, "runtimes");
  if (existsSync(runtimesDir) && statSync(runtimesDir).isDirectory()) {
    for (const sub of readdirSync(runtimesDir).sort()) {
      const md = join(runtimesDir, sub, "PLUGIN.md");
      if (existsSync(md)) files.push(md);
    }
  }
  if (files.length === 0) {
    console.error(`✗ ${path}: no PLUGIN.md found (root or runtimes/*/)`);
    process.exitCode = 1;
  }
  return files;
}

function validateFile(filePath: string): ParsedPluginMd | null {
  const content = readFileSync(filePath, "utf-8");

  let parsed: ReturnType<typeof parsePluginMd>;
  try {
    parsed = parsePluginMd(content, filePath);
  } catch (error: unknown) {
    console.error(`✗ ${filePath} (loader parse)`);
    console.error(
      `  ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // The loader may omit malformed optional fields after warning. The
  // authoring contract must still reject their original declarations.
  const result = runtimeManifestAuthoringSchema.safeParse(
    parsed.rawFrontmatter,
  );
  if (!result.success) {
    console.error(`✗ ${filePath} (authoring schema)`);
    for (const issue of result.error.issues) {
      console.error(
        `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
    }
    return null;
  }
  // A file argument must receive the same package-layout check as a directory.
  // An empty runtimes/ directory still uses the single-runtime root contract.
  const runtimesDir = join(dirname(filePath), "runtimes");
  const isMultiRuntimeRoot =
    basename(filePath) === "PLUGIN.md" &&
    existsSync(runtimesDir) &&
    statSync(runtimesDir).isDirectory() &&
    readdirSync(runtimesDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(runtimesDir, entry.name, "PLUGIN.md")),
    );
  const diagnostics = isMultiRuntimeRoot
    ? multiRuntimeRootDiagnostics(parsed.rawFrontmatter)
    : [];
  if (diagnostics.length > 0) {
    console.error(`✗ ${filePath} (multi-runtime root)`);
    for (const diagnostic of diagnostics) {
      console.error(`  - ${diagnostic.path}: ${diagnostic.message}`);
    }
    return null;
  }
  if (
    basename(dirname(dirname(filePath))) === "runtimes" &&
    !hasRuntimeDeclaration(parsed.manifest)
  ) {
    console.error(
      `✗ ${filePath}: runtime declaration requires execution fields; move package-only declarations to the root PLUGIN.md`,
    );
    return null;
  }
  console.log(`✓ ${filePath}`);
  return parsed;
}

// Package and runtime-local contributions share one conflict contract.
const seenContexts = new Set<string>();
for (const path of paths) {
  const files = collectManifestFiles(path);
  if (files.length === 0) continue;
  const context = files
    .map((file) => resolve(file))
    .sort()
    .join("\0");
  if (seenContexts.has(context)) continue;
  seenContexts.add(context);
  const checked: ParsedPluginMd[] = [];
  for (const file of files) {
    const parsed = validateFile(file);
    if (parsed) checked.push(parsed);
    else process.exitCode = 1;
  }
  try {
    validatePluginDeclarations(checked);
  } catch (error) {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
