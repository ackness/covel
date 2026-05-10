#!/usr/bin/env node
/**
 * check-no-chinese-literal — guard rail against reintroducing raw CJK
 * strings in apps/web runtime code.
 *
 * Scans apps/web/src/**\/*.{ts,tsx} for CJK characters. Ignores:
 *   - block (/* ... *\/) and line (//) comments
 *   - JSX comments  { /* ... *\/ }
 *   - files in the WHITELIST (locales, data models, tests)
 *   - any line ending in `// i18n-allow` escape hatch
 *
 * Exit code:
 *   0 — no findings
 *   1 — CJK literal detected (prints file:line:col + offending content)
 *
 * Run via: `pnpm --filter @covel/web check:i18n`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const SRC_ROOT = resolve(WEB_ROOT, "src");

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
// Allow sentinel is recognized anywhere on the line (inside //, /* */ or
// JSX {/* ... */}) so JSX authors can keep the marker visually close.
const ALLOW_COMMENT = /\bi18n-allow\b/;

// Files that are explicitly allowed to contain CJK. Paths are relative
// to apps/web and matched with `startsWith`.
//
// Bilingual `{ "zh-CN": ..., "en-US": ... }` config objects in settings /
// theme registries are i18n data themselves — the literal IS the locale
// value. They go on this list rather than getting per-line `// i18n-allow`
// comments cluttering every label entry.
const WHITELIST_PREFIXES = [
  "src/i18n/locales/",
  "src/services/data-service.ts", // I18nText data model (not UI strings)
  "src/services/data-service/seed-worlds.ts", // bilingual I18nText seed data
  "src/settings/navigation.ts", // bilingual group/subgroup labels
  "src/settings/registry/", // bilingual SettingEntry registries (core, llm, keys)
  "src/theme-system/registry.ts", // bilingual appearance/theme registry
];

// Directory suffixes to skip outright.
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", "__tests__"]);

// File basenames / suffixes to skip.
const SKIP_FILE_SUFFIXES = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

function isWhitelisted(relPath) {
  return WHITELIST_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(prefix),
  );
}

function shouldSkipFile(name, relPath) {
  if (SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (!(name.endsWith(".ts") || name.endsWith(".tsx"))) return true;
  if (isWhitelisted(relPath)) return true;
  return false;
}

function walk(dir, out) {
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      walk(full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = relative(WEB_ROOT, full).split("\\").join("/");
    if (shouldSkipFile(name, rel)) continue;
    out.push(full);
  }
}

/**
 * Strip comments while preserving string content. Runs a small state
 * machine so regex noise (URLs with //, strings containing /* etc.)
 * does not false-negative.
 *
 * Returns an array of the original length where comment characters
 * have been replaced with spaces (preserving column positions).
 */
function stripComments(source) {
  const out = source.split("");
  const len = source.length;
  let i = 0;
  let state = "code"; // code | lineComment | blockComment | string | template
  let stringQuote = "";
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        // line comment
        state = "lineComment";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "blockComment";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        state = "string";
        stringQuote = ch;
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "template";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "lineComment") {
      if (ch === "\n") {
        state = "code";
        i += 1;
        continue;
      }
      out[i] = ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        state = "code";
        i += 2;
        continue;
      }
      out[i] = ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (state === "string") {
      if (ch === "\\") {
        // keep escape + next char
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        state = "code";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
  }
  return out.join("");
}

/**
 * Scan a single file. Returns an array of findings {line, col, excerpt}.
 */
function scanFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const originalLines = source.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!CJK_REGEX.test(line)) continue;
    const original = originalLines[i];
    if (ALLOW_COMMENT.test(original)) continue;
    const match = line.match(CJK_REGEX);
    if (!match) continue;
    const col = (match.index ?? 0) + 1;
    findings.push({
      line: i + 1,
      col,
      excerpt: original.trim().slice(0, 160),
    });
  }
  return findings;
}

function main() {
  const files = [];
  walk(SRC_ROOT, files);
  let total = 0;
  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length === 0) continue;
    const rel = relative(WEB_ROOT, file);
    for (const f of findings) {
      total += 1;
      // eslint-disable-next-line no-console
      console.error(
        `${rel}:${f.line}:${f.col}: raw CJK literal — move to i18n dictionary or mark // i18n-allow`,
      );
      // eslint-disable-next-line no-console
      console.error(`  ${f.excerpt}`);
    }
  }
  if (total > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\ncheck-no-chinese-literal: ${total} finding(s) across ${files.length} file(s)`,
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`check-no-chinese-literal: OK (${files.length} file(s) scanned)`);
}

main();
