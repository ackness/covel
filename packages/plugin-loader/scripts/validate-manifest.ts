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

function validateFile(filePath: string): Record<string, unknown> | null {
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
    return null;
  }

  if (compatOnly) {
    console.log(`✓ ${filePath} (compat)`);
    return manifest;
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
    return null;
  }
  console.log(`✓ ${filePath}`);
  return manifest;
}

// ── Cross-runtime (plugin-scope) checks ───────────────────────────

interface CheckedManifest {
  readonly file: string;
  readonly manifest: Record<string, unknown>;
}

/** Key-order-independent serialisation, so field ordering is not a difference. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : val,
  );
}

/**
 * Fields that are plugin-scoped even though they are declared on a runtime
 * manifest: the framework loads them once per plugin, so a second declaration
 * is silently dropped rather than merged. The per-file schema cannot see this
 * — it only ever looks at one manifest.
 */
const SINGLE_DECLARATION_FIELDS = ["entry", "wires"] as const;

function checkSingleDeclaration(checked: readonly CheckedManifest[]): boolean {
  let ok = true;
  for (const field of SINGLE_DECLARATION_FIELDS) {
    const declaring = checked.filter((c) => c.manifest[field] !== undefined);
    if (declaring.length <= 1) continue;
    ok = false;
    console.error(
      `✗ \`${field}\` is declared by ${declaring.length} runtimes — it is loaded once per plugin, so only one takes effect`,
    );
    for (const c of declaring) console.error(`  - ${c.file}`);
    console.error(
      `  Fix: keep the single \`${field}\` declaration on the root PLUGIN.md and remove the others.`,
    );
  }
  return ok;
}

/**
 * `userSettings` are stored under the plugin-scoped key
 * `plugin.<pluginId>.<key>`, so two runtimes declaring the same key share one
 * value. Identical declarations are fine (the server dedupes them); diverging
 * ones mean only one wins, and which one depends on manifest load order.
 */
function checkUserSettingCollisions(
  checked: readonly CheckedManifest[],
): boolean {
  const seen = new Map<string, { file: string; json: string }>();
  let ok = true;
  for (const { file, manifest } of checked) {
    const specs = manifest.userSettings;
    if (!Array.isArray(specs)) continue;
    for (const spec of specs as Array<Record<string, unknown>>) {
      const key = String(spec.key);
      const json = stableJson(spec);
      const prior = seen.get(key);
      if (!prior) {
        seen.set(key, { file, json });
        continue;
      }
      if (prior.json === json) continue;
      ok = false;
      console.error(
        `✗ userSettings key "${key}" is declared differently by two runtimes — both map to one stored value`,
      );
      console.error(`  - ${prior.file}`);
      console.error(`  - ${file}`);
      console.error(
        `  Fix: declare the key on one runtime, or make both declarations identical.`,
      );
    }
  }
  return ok;
}

for (const path of paths) {
  const checked: CheckedManifest[] = [];
  for (const file of collectManifestFiles(path)) {
    const manifest = validateFile(file);
    if (manifest) checked.push({ file, manifest });
    else process.exitCode = 1;
  }
  if (checked.length < 2) continue;
  if (!checkSingleDeclaration(checked)) process.exitCode = 1;
  if (!checkUserSettingCollisions(checked)) process.exitCode = 1;
}
