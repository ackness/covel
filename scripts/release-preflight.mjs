#!/usr/bin/env node
/**
 * Release preflight — run BEFORE pushing a v* tag.
 *
 * Catches every static failure mode that has historically broken the
 * release workflow without needing a macOS runner. Designed to take
 * <10 seconds on a warm cache.
 *
 * Checks:
 *   1. Lockfile is in sync (`pnpm install --frozen-lockfile` would not
 *      change anything).
 *   2. Every `import` in `packages/<pkg>/src/**` and
 *      `apps/<app>/src/**` resolves to either a Node builtin, a
 *      workspace package, or a declared dep/devDep — catches the
 *      "hoisted-but-undeclared" failures that pass locally but break
 *      under `--frozen-lockfile`.
 *   3. Every `plugins/<id>/` has a `package.json` and either a root
 *      `PLUGIN.md` or `runtimes/<sub>/PLUGIN.md` — what
 *      verify-release.mjs enforces in CI.
 *   4. Every `worlds/<id>/` has `world.yaml` + at least one
 *      `WORLD*.md`.
 *   5. `prompts/server/` has at least one `*.md`.
 *   6. `actionlint` passes (when installed).
 *
 * Exit code 0 = safe to push. Non-zero = fix before tagging.
 *
 * Usage:
 *   node scripts/release-preflight.mjs        # full
 *   node scripts/release-preflight.mjs --skip-lockfile  # skip the install
 *
 * Wired into the root package.json as `pnpm release:preflight`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import module from "node:module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));

const FAIL = [];
const WARN = [];
function fail(msg) {
  FAIL.push(msg);
  console.error(`  ✗ ${msg}`);
}
function warn(msg) {
  WARN.push(msg);
  console.warn(`  ! ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

const builtin = new Set(module.builtinModules.flatMap((n) => [n, `node:${n}`]));

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "tests" ||
      entry.name === "__tests__"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

// Match imports that begin a *line* — that's the only safe heuristic
// without an AST.
const STATIC_IMPORT_RE =
  /^\s*(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/gm;
const REQUIRE_RE = /^[^"']*\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/gm;
const AWAIT_IMPORT_RE = /\bawait\s+import\(\s*["']([^"'.][^"']*)["']\s*\)/g;
// `await import("X").catch(...)` signals an opt-in optional runtime dep:
// the caller explicitly handles a missing package, so it does NOT need to
// appear in package.json. Detected so the required-set excludes it.
const OPTIONAL_AWAIT_IMPORT_RE =
  /\bawait\s+import\(\s*["']([^"'.][^"']*)["']\s*\)\s*\.catch\b/g;

// Replace backtick-delimited template literal contents with spaces (preserving
// newlines so line-anchored regexes still align). Code-generation templates
// (e.g. packages/create) embed real-looking `import` statements inside backticks
// — without stripping, those false-positive as imports of the host package.
// Does not recurse into `${...}` expressions; backtick strings nested inside
// interpolations are vanishingly rare here.
function stripTemplateLiterals(source) {
  return source.replace(/`(?:\\[\s\S]|[^`\\])*`/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

function extractBareImports(source) {
  const stripped = stripTemplateLiterals(source);
  const required = new Set();
  const optional = new Set();
  for (let m; (m = OPTIONAL_AWAIT_IMPORT_RE.exec(stripped)); ) {
    optional.add(m[1]);
  }
  for (const re of [
    STATIC_IMPORT_RE,
    SIDE_EFFECT_IMPORT_RE,
    REQUIRE_RE,
    AWAIT_IMPORT_RE,
  ]) {
    let m;
    while ((m = re.exec(stripped))) {
      const spec = m[1];
      // Relative paths and absolute paths are not bare imports.
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      // tsconfig path aliases (e.g. `@/components`, `~/foo`) — not npm packages.
      if (spec.startsWith("@/") || spec.startsWith("~/")) continue;
      if (optional.has(spec)) continue;
      required.add(spec);
    }
  }
  return { required, optional };
}

function pkgRoot(spec) {
  // `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    return name ? `${scope}/${name}` : scope;
  }
  return spec.split("/")[0];
}

// ── 1. Lockfile sync ─────────────────────────────────────────────
console.log("\n[1/6] Lockfile sync (pnpm --frozen-lockfile dry-run)");
if (args.has("--skip-lockfile")) {
  warn("skipped (--skip-lockfile)");
} else {
  try {
    execSync("pnpm install --frozen-lockfile --prefer-offline", {
      cwd: repoRoot,
      stdio: "pipe",
    });
    ok("pnpm-lock.yaml in sync with package.jsons");
  } catch (e) {
    fail(
      `pnpm install --frozen-lockfile failed:\n${e.stderr?.toString() ?? e.message}`,
    );
  }
}

// ── 2. Undeclared imports ─────────────────────────────────────────
console.log("\n[2/6] Undeclared bare imports across packages/* and apps/*");
const wsPkgDirs = [
  ...fs
    .readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/${e.name}`),
  ...fs
    .readdirSync(path.join(repoRoot, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `apps/${e.name}`),
];

let undeclaredCount = 0;
for (const rel of wsPkgDirs) {
  const pkgJsonPath = path.join(repoRoot, rel, "package.json");
  if (!fs.existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);

  const srcFiles = listFiles(path.join(repoRoot, rel, "src"), [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".mjs",
    ".jsx",
  ]);
  const undeclared = new Set();
  for (const file of srcFiles) {
    const source = fs.readFileSync(file, "utf-8");
    const { required } = extractBareImports(source);
    for (const spec of required) {
      const root = pkgRoot(spec);
      if (builtin.has(root)) continue;
      if (declared.has(root)) continue;
      // self-import (a package re-exporting from its own name via tsconfig
      // paths or workspace alias) is fine.
      if (root === pkg.name) continue;
      undeclared.add(root);
    }
  }
  if (undeclared.size > 0) {
    fail(
      `${rel}: imports not in package.json — ${[...undeclared].sort().join(", ")}`,
    );
    undeclaredCount += undeclared.size;
  }
}
if (undeclaredCount === 0)
  ok(`all ${wsPkgDirs.length} workspace packages have all imports declared`);

// ── 3. plugins/ structure ─────────────────────────────────────────
console.log("\n[3/6] plugins/<id>/ structure (verify-release sentinels)");
const isPluginManifest = (f) => /^PLUGIN(\.[a-z-]+)?\.md$/i.test(f);
const pluginDirs = fs
  .readdirSync(path.join(repoRoot, "plugins"), { withFileTypes: true })
  .filter((e) => e.isDirectory());
let pluginIssues = 0;
for (const entry of pluginDirs) {
  const dir = path.join(repoRoot, "plugins", entry.name);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    fail(`plugins/${entry.name}: missing package.json`);
    pluginIssues++;
    continue;
  }
  const hasRoot =
    fs.existsSync(dir) && fs.readdirSync(dir).some(isPluginManifest);
  let hasNested = false;
  const runtimesDir = path.join(dir, "runtimes");
  if (fs.existsSync(runtimesDir)) {
    hasNested = fs
      .readdirSync(runtimesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .some((sub) =>
        fs.readdirSync(path.join(runtimesDir, sub.name)).some(isPluginManifest),
      );
  }
  if (!hasRoot && !hasNested) {
    fail(`plugins/${entry.name}: no PLUGIN.md (root or runtimes/*/)`);
    pluginIssues++;
  }
}
if (pluginIssues === 0)
  ok(`all ${pluginDirs.length} plugins have package.json + PLUGIN.md`);

// ── 4. worlds/ structure ──────────────────────────────────────────
console.log("\n[4/6] worlds/<id>/ structure");
const worldDirs = fs
  .readdirSync(path.join(repoRoot, "worlds"), { withFileTypes: true })
  .filter((e) => e.isDirectory());
let worldIssues = 0;
for (const entry of worldDirs) {
  const dir = path.join(repoRoot, "worlds", entry.name);
  if (!fs.existsSync(path.join(dir, "world.yaml"))) {
    fail(`worlds/${entry.name}: missing world.yaml`);
    worldIssues++;
  }
  const hasLore = fs
    .readdirSync(dir)
    .some((f) => /^WORLD(\.[a-z-]+)?\.md$/i.test(f));
  if (!hasLore) {
    fail(`worlds/${entry.name}: missing WORLD*.md`);
    worldIssues++;
  }
}
if (worldIssues === 0)
  ok(`all ${worldDirs.length} worlds have world.yaml + WORLD*.md`);

// ── 5. prompts/server/ ────────────────────────────────────────────
console.log("\n[5/6] prompts/server/*.md");
const promptsDir = path.join(repoRoot, "prompts/server");
if (!fs.existsSync(promptsDir)) {
  fail("prompts/server/ does not exist");
} else {
  const md = fs.readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
  if (md.length === 0) fail("prompts/server/ has no .md files");
  else ok(`${md.length} prompt files present`);
}

// ── 6. actionlint ────────────────────────────────────────────────
console.log("\n[6/6] GitHub Actions workflow lint");
try {
  execSync("which actionlint", { stdio: "pipe" });
  try {
    execSync("actionlint .github/workflows/*.yml", {
      cwd: repoRoot,
      stdio: "pipe",
    });
    ok("actionlint passed");
  } catch (e) {
    fail(
      `actionlint:\n${e.stdout?.toString() ?? e.stderr?.toString() ?? e.message}`,
    );
  }
} catch {
  warn("actionlint not installed — `brew install actionlint` to enable");
}

// ── Summary ──────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60));
if (FAIL.length > 0) {
  console.error(`\n✗ ${FAIL.length} blocker(s) — fix before pushing v* tag:\n`);
  for (const m of FAIL) console.error(`  • ${m}`);
  if (WARN.length > 0) console.warn(`\n  (${WARN.length} warning(s))`);
  process.exit(1);
}
console.log(
  `\n✓ Preflight passed${WARN.length > 0 ? ` (${WARN.length} warning(s))` : ""}`,
);
console.log(
  "  Safe to: git tag -a v0.0.x -m '...' && git push origin v0.0.x\n",
);
