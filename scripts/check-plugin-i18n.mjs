#!/usr/bin/env node
/**
 * check-plugin-i18n - enforce the I18nText contract for plugin-facing text.
 *
 * JSON UI specs:
 *   - Scans plugins/**\/ui/*.json and templates/**\/ui/*.json, including
 *     nested runtime ui directories.
 *   - Bare CJK strings are rejected. Wrap them as I18nText objects.
 *   - I18nText objects should include both zh/zh-CN and en/en-US/en-GB.
 *
 * PLUGIN.md frontmatter:
 *   - Scans user-visible fields such as description, displayName, label,
 *     title, placeholder, and options[].label/description.
 *   - Bare CJK strings in those fields are rejected.
 *   - I18nText objects should include both Chinese and English locales.
 *
 * Exit code: 0 = OK, 1 = violations found.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const CJK_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCAN_ROOTS = ["plugins", "templates"];
const USER_VISIBLE_KEYS = new Set([
  "description",
  "displayName",
  "emptyText",
  "groupLabel",
  "help",
  "hint",
  "label",
  "message",
  "placeholder",
  "shortLabel",
  "subtitle",
  "summary",
  "text",
  "title",
  "tooltip",
]);
// Allow the author to exempt a specific path by prefix if a false positive
// ever appears. Keep empty by default.
const EXEMPT_PREFIXES = [];

function isChineseLocaleKey(key) {
  return key === "zh" || key === "zh-CN";
}

function isEnglishLocaleKey(key) {
  return key === "en" || key === "en-US" || key === "en-GB";
}

function hasLocaleKey(keys) {
  return keys.some(isChineseLocaleKey) || keys.some(isEnglishLocaleKey);
}

function isI18nTextObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (!hasLocaleKey(keys)) return false;
  return keys.every((key) => typeof value[key] === "string");
}

function localeCoverage(value) {
  const keys = Object.keys(value);
  return {
    hasZh: keys.some(isChineseLocaleKey),
    hasEn: keys.some(isEnglishLocaleKey),
  };
}

function pathToString(pathStack) {
  return pathStack.length > 0 ? pathStack.join(".") : "(root)";
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".vendor",
  "coverage",
  ".git",
]);

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walkFiles(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function isUiJsonFile(rel) {
  const parts = rel.split(sep);
  return (
    (parts.length >= 4 &&
      parts[0] === "plugins" &&
      parts.includes("ui") &&
      rel.endsWith(".json")) ||
    (parts.length >= 4 &&
      parts[0] === "templates" &&
      parts.includes("ui") &&
      rel.endsWith(".json"))
  );
}

function isPluginMarkdownFile(rel) {
  const parts = rel.split(sep);
  return (
    (parts[0] === "plugins" || parts[0] === "templates") &&
    basename(rel) === "PLUGIN.md"
  );
}

function isPluginHandlerJsFile(rel) {
  const parts = rel.split(sep);
  if (parts[0] !== "plugins" && parts[0] !== "templates") return false;
  if (!rel.endsWith(".js")) return false;
  if (rel.endsWith(".test.js")) return false;
  return true;
}

// A UI-label-ish object key assigned a bare quoted string literal. Catches
// `label: "观察"` written into plugin_data by a tool/handler (which bypasses
// the JSON/frontmatter scans above and renders untranslated for en players),
// without matching I18nText objects (`label: { zh: … }` — the value starts with
// `{`, not a quote) or prose constants (not a `label:` assignment).
const HANDLER_LABEL_RE =
  /\b(label|title|placeholder|tooltip)\s*:\s*(["'`])((?:(?!\2).)*)\2/g;

function checkHandlerJsFiles() {
  const files = collectFiles(isPluginHandlerJsFile);
  let totalViolations = 0;

  for (const rel of files) {
    const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    HANDLER_LABEL_RE.lastIndex = 0;
    let match;
    while ((match = HANDLER_LABEL_RE.exec(text)) !== null) {
      const key = match[1];
      const literal = match[3];
      if (!CJK_REGEX.test(literal)) continue;
      totalViolations += 1;
      console.error(
        `${rel}: \`${key}: "${literal.slice(0, 60)}"\` is a bare-CJK display label written from a handler - store it as an I18nText object { zh, en } so the frontend resolves the locale.`,
      );
    }
  }

  return { files, totalViolations };
}

function collectFiles(predicate) {
  const files = [];
  for (const root of SCAN_ROOTS) {
    for (const full of walkFiles(resolve(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, full);
      if (EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
      if (predicate(rel)) files.push(rel);
    }
  }
  files.sort();
  return files;
}

function isTemplatedString(value) {
  return /^\s*\{\{[^}]+\}\}\s*$/.test(value);
}

function reportBareCjk(violations, pathStack, value, context) {
  if (!CJK_REGEX.test(value)) return;
  violations.push({
    kind: "bare-cjk",
    path: pathStack.slice(),
    value,
    context,
  });
}

function reportIncompleteLocale(violations, pathStack, value, context) {
  const { hasZh, hasEn } = localeCoverage(value);
  if (hasZh && hasEn) return;
  violations.push({
    kind: "incomplete-locale",
    path: pathStack.slice(),
    value: JSON.stringify(value),
    context,
  });
}

function walkJsonValue(value, pathStack, violations) {
  if (value == null) return;
  if (typeof value === "string") {
    reportBareCjk(violations, pathStack, value, "JSON UI");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      pathStack.push(`[${index}]`);
      walkJsonValue(item, pathStack, violations);
      pathStack.pop();
    });
    return;
  }
  if (typeof value === "object") {
    if (isI18nTextObject(value)) {
      reportIncompleteLocale(violations, pathStack, value, "JSON UI");
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      pathStack.push(key);
      walkJsonValue(child, pathStack, violations);
      pathStack.pop();
    }
  }
}

function fieldMayBeVisible(pathStack, keys = USER_VISIBLE_KEYS) {
  if (pathStack.length === 0) return false;
  const last = pathStack[pathStack.length - 1];
  if (keys.has(last)) return true;
  return pathStack.some((part) => keys.has(part));
}

function walkPluginField(
  value,
  pathStack,
  violations,
  context = "PLUGIN.md frontmatter",
  keys = USER_VISIBLE_KEYS,
) {
  if (value == null) return;
  const visible = fieldMayBeVisible(pathStack, keys);
  if (typeof value === "string") {
    if (visible && !isTemplatedString(value)) {
      reportBareCjk(violations, pathStack, value, context);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      pathStack.push(`[${index}]`);
      walkPluginField(item, pathStack, violations, context, keys);
      pathStack.pop();
    });
    return;
  }
  if (typeof value === "object") {
    if (visible && isI18nTextObject(value)) {
      reportIncompleteLocale(violations, pathStack, value, context);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      pathStack.push(key);
      walkPluginField(child, pathStack, violations, context, keys);
      pathStack.pop();
    }
  }
}

function extractFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  return text.slice(3, end).trim();
}

function normalizeTemplatePlaceholders(frontmatter) {
  return frontmatter.replaceAll(/\{\{[^}]+\}\}/g, "template-placeholder");
}

function printViolation(rel, violation) {
  const pathStr = pathToString(violation.path);
  const sample = violation.value.slice(0, 120);
  if (violation.kind === "bare-cjk") {
    console.error(
      `${rel}: "${pathStr}" contains bare CJK string "${sample}" in ${violation.context} - wrap it in { "zh": "...", "en": "..." }`,
    );
    return;
  }
  console.error(
    `${rel}: "${pathStr}" is an I18nText object without both Chinese and English locales: ${sample}`,
  );
}

function checkJsonFiles() {
  const files = collectFiles(isUiJsonFile);
  let totalViolations = 0;

  for (const rel of files) {
    const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error(`${rel}: failed to parse JSON - ${err.message}`);
      totalViolations += 1;
      continue;
    }

    const violations = [];
    walkJsonValue(parsed, [], violations);
    for (const violation of violations) {
      totalViolations += 1;
      printViolation(rel, violation);
    }
  }

  return { files, totalViolations };
}

function checkPluginMarkdownFiles() {
  const files = collectFiles(isPluginMarkdownFile);
  let totalViolations = 0;

  for (const rel of files) {
    const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    const frontmatter = extractFrontmatter(text);
    if (frontmatter == null) continue;

    let parsed;
    try {
      parsed = YAML.parse(normalizeTemplatePlaceholders(frontmatter));
    } catch (err) {
      console.error(`${rel}: failed to parse frontmatter - ${err.message}`);
      totalViolations += 1;
      continue;
    }

    const violations = [];
    walkPluginField(parsed, [], violations);
    for (const violation of violations) {
      totalViolations += 1;
      printViolation(rel, violation);
    }
  }

  return { files, totalViolations };
}

// World manifests: world.yaml display fields (name/summary + memoryBlocks /
// characterAttributes labels) must be I18nText, same contract as plugins. The
// `data/` content (character cards, rule prose) is authored narrative and is
// intentionally out of scope here.
const WORLD_VISIBLE_KEYS = new Set([
  ...USER_VISIBLE_KEYS,
  "name", // world title + characterAttributes[].name
  "extractionHint", // memoryBlocks[].extractionHint
]);

function checkWorldFiles() {
  const files = [];
  for (const full of walkFiles(resolve(REPO_ROOT, "worlds"))) {
    const rel = relative(REPO_ROOT, full);
    const parts = rel.split(sep);
    if (parts.includes("_archive")) continue; // archived worlds aren't loaded
    if (basename(rel) !== "world.yaml") continue;
    files.push(rel);
  }
  files.sort();

  let totalViolations = 0;
  for (const rel of files) {
    const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    let parsed;
    try {
      parsed = YAML.parse(text);
    } catch (err) {
      console.error(`${rel}: failed to parse world.yaml - ${err.message}`);
      totalViolations += 1;
      continue;
    }
    const violations = [];
    walkPluginField(parsed, [], violations, "world.yaml", WORLD_VISIBLE_KEYS);
    for (const violation of violations) {
      totalViolations += 1;
      printViolation(rel, violation);
    }
  }
  return { files, totalViolations };
}

const jsonResult = checkJsonFiles();
const pluginMdResult = checkPluginMarkdownFiles();
const handlerJsResult = checkHandlerJsFiles();
const worldResult = checkWorldFiles();
const totalViolations =
  jsonResult.totalViolations +
  pluginMdResult.totalViolations +
  handlerJsResult.totalViolations +
  worldResult.totalViolations;

if (totalViolations > 0) {
  console.error(
    `\ncheck-plugin-i18n: ${totalViolations} violation(s) across ${jsonResult.files.length} plugin/template UI file(s), ${pluginMdResult.files.length} PLUGIN.md file(s), ${handlerJsResult.files.length} handler .js file(s), and ${worldResult.files.length} world.yaml file(s)`,
  );
  process.exit(1);
}

console.log(
  `check-plugin-i18n: OK (${jsonResult.files.length} plugin/template UI file(s), ${pluginMdResult.files.length} PLUGIN.md file(s), ${handlerJsResult.files.length} handler .js file(s), ${worldResult.files.length} world.yaml file(s) scanned)`,
);
