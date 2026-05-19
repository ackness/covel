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

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
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

function fieldMayBeVisible(pathStack) {
  if (pathStack.length === 0) return false;
  const last = pathStack[pathStack.length - 1];
  if (USER_VISIBLE_KEYS.has(last)) return true;
  return pathStack.some((part) => USER_VISIBLE_KEYS.has(part));
}

function walkPluginField(value, pathStack, violations) {
  if (value == null) return;
  const visible = fieldMayBeVisible(pathStack);
  if (typeof value === "string") {
    if (visible && !isTemplatedString(value)) {
      reportBareCjk(violations, pathStack, value, "PLUGIN.md frontmatter");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      pathStack.push(`[${index}]`);
      walkPluginField(item, pathStack, violations);
      pathStack.pop();
    });
    return;
  }
  if (typeof value === "object") {
    if (visible && isI18nTextObject(value)) {
      reportIncompleteLocale(
        violations,
        pathStack,
        value,
        "PLUGIN.md frontmatter",
      );
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      pathStack.push(key);
      walkPluginField(child, pathStack, violations);
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

const jsonResult = checkJsonFiles();
const pluginMdResult = checkPluginMarkdownFiles();
const totalViolations =
  jsonResult.totalViolations + pluginMdResult.totalViolations;

if (totalViolations > 0) {
  console.error(
    `\ncheck-plugin-i18n: ${totalViolations} violation(s) across ${jsonResult.files.length} plugin/template UI file(s) and ${pluginMdResult.files.length} PLUGIN.md file(s)`,
  );
  process.exit(1);
}

console.log(
  `check-plugin-i18n: OK (${jsonResult.files.length} plugin/template UI file(s), ${pluginMdResult.files.length} PLUGIN.md file(s) scanned)`,
);
