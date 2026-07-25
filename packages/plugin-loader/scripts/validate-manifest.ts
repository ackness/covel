#!/usr/bin/env tsx
/**
 * Validate PLUGIN.md manifests from the command line.
 *
 * Usage:
 *   pnpm validate:plugin <path...> [--compat]
 *
 * A path may be a PLUGIN.md file or a plugin directory (validates the root
 * PLUGIN.md if present plus every runtimes/<sub>/PLUGIN.md).
 *
 * Two passes per file:
 *  1. `parsePluginMd` — the loader's own compat parse (I18nText description
 *     folding, lenient-field handling, line-numbered errors). This is what
 *     decides whether the plugin LOADS.
 *  2. `runtimeManifestAuthoringSchema` — the strict authoring target: every
 *     cross-field constraint enforced, including a required stage on
 *     auto/scheduled runtimes. Skipped with `--compat`, which checks only
 *     whether the manifest loads.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePluginMd } from "../src/parse-plugin-md.js";
import { runtimeManifestAuthoringSchema } from "@covel/shared";

const args = process.argv.slice(2);
const compatOnly = args.includes("--compat");
const paths = args.filter((a) => a !== "--compat");

if (paths.length === 0) {
  console.error(
    "Usage: pnpm validate:plugin <PLUGIN.md | plugin-dir>... [--compat]",
  );
  process.exit(2);
}

function collectManifestFiles(path: string): string[] {
  if (!existsSync(path)) {
    console.error(`✗ ${path}: no such file or directory`);
    process.exitCode = 1;
    return [];
  }
  if (statSync(path).isFile()) return [path];
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

function validateFile(filePath: string): boolean {
  const content = readFileSync(filePath, "utf-8");

  let manifest: Record<string, unknown>;
  try {
    manifest = parsePluginMd(content, filePath).manifest as unknown as Record<
      string,
      unknown
    >;
  } catch (error: unknown) {
    console.error(`✗ ${filePath} (loader parse)`);
    console.error(
      `  ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  if (compatOnly) {
    console.log(`✓ ${filePath} (compat)`);
    return true;
  }

  // parsePluginMd appends the derived pluginId; the strict schema rejects
  // unknown keys, so strip it before the authoring pass.
  const { pluginId: _derived, ...authoringInput } = manifest;
  const result = runtimeManifestAuthoringSchema.safeParse(authoringInput);
  if (!result.success) {
    console.error(`✗ ${filePath} (authoring schema)`);
    for (const issue of result.error.issues) {
      console.error(
        `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
    }
    return false;
  }
  console.log(`✓ ${filePath}`);
  return true;
}

const files = paths.flatMap(collectManifestFiles);
for (const file of files) {
  if (!validateFile(file)) process.exitCode = 1;
}
