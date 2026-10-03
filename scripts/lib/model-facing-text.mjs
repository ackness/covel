/**
 * Checks for text that reaches a model.
 *
 * The plugin i18n gate checked what a player sees: labels in UI specs,
 * manifests and handlers. Nothing checked what a model is told. Tool
 * definitions and framework prompt text written in Chinese then went to the
 * model in every session, whatever its language, and the model answered in
 * Chinese in an English session.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CJK = /[㐀-䶿一-鿿]/;

/** `description:` and `.describe(` take the text of a tool or a parameter. */
const TOOL_TEXT =
  /(\bdescription\s*:\s*|\.describe\(\s*)(["'`])((?:\\.|(?!\2)[\s\S])*)\2/g;

/**
 * Tool and parameter descriptions that contain Chinese. A tool definition is
 * an instruction: it is English, like the prompt body. A description shown to
 * the player is a locale pair, never a bare literal, so a hit is wrong either
 * way.
 *
 * @param {string} source
 * @returns {{ line: number, text: string }[]}
 */
export function findChineseToolText(source) {
  const found = [];
  TOOL_TEXT.lastIndex = 0;
  let match;
  while ((match = TOOL_TEXT.exec(source)) !== null) {
    if (!CJK.test(match[3])) continue;
    found.push({
      line: source.slice(0, match.index).split("\n").length,
      text: match[3].slice(0, 60),
    });
  }
  return found;
}

/** Drop comments, so only code and string literals remain. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

/** Number of lines of a source file that hold Chinese outside comments. */
export function chineseLineCount(source) {
  return withoutComments(source)
    .split("\n")
    .filter((line) => CJK.test(line)).length;
}

function* sourceFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name === "tests" ||
      name === "__tests__" ||
      name.startsWith(".")
    )
      continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name))
      yield full;
  }
}

/**
 * Compare the Chinese text in framework source with a recorded table.
 *
 * Framework code has few legitimate reasons to contain Chinese: the Chinese
 * variant of an instruction, a label map, a pattern that matches Chinese. The
 * table records, per file, how many lines do. A file that is not in the table,
 * or whose count changed, fails: adding Chinese to framework code is then a
 * deliberate edit of the table, visible in review, not something that slips
 * in with a tool description.
 *
 * @param {{ repoRoot: string, roots: readonly string[], allowed: Readonly<Record<string, number>> }} options
 * @returns {string[]} problems
 */
export function checkFrameworkChinese({ repoRoot, roots, allowed }) {
  const problems = [];
  const seen = new Set();
  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    let files;
    try {
      files = [...sourceFiles(dir)];
    } catch {
      continue;
    }
    for (const full of files) {
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      const count = chineseLineCount(readFileSync(full, "utf8"));
      const expected = allowed[rel];
      if (expected !== undefined) seen.add(rel);
      if (count === (expected ?? 0)) continue;
      problems.push(
        expected === undefined
          ? `${rel}: ${count} line(s) of Chinese text in framework source. Text sent to a model is English; text shown to a player is a locale pair resolved by the locale helpers. If this file needs Chinese, record it in FRAMEWORK_CHINESE_LINES with the reason.`
          : `${rel}: ${count} line(s) of Chinese text, ${expected} recorded. If the change is intended, update FRAMEWORK_CHINESE_LINES.`,
      );
    }
  }
  for (const rel of Object.keys(allowed))
    if (!seen.has(rel))
      problems.push(
        `${rel}: recorded in FRAMEWORK_CHINESE_LINES but not found. Remove the entry.`,
      );
  return problems;
}
