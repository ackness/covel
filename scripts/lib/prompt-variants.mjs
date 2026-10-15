/**
 * Keep each plugin prompt and its Chinese variant from drifting apart.
 *
 * The canonical `PLUGIN.md` / `RUNTIME.md` is English and is the source of
 * truth. `*.zh.md` is a translation of it. A translation goes stale silently:
 * the English prompt changes, the Chinese one keeps an old instruction, and
 * Chinese sessions behave differently. Three checks make that visible:
 *
 *   1. The canonical prompt is English; only Simplified Chinese variants
 *      (`*.zh.md`) exist. The templates under a plugin's `prompts/`
 *      directory follow the same rule.
 *   2. Both languages name the same tools, injected blocks and bound inputs.
 *   3. A lock file records the hash of each pair. When the English prompt
 *      changes and the Chinese one does not, the check fails.
 *
 * Bundled plugins ship both languages, so with `requireChinese` every prompt a
 * model reads must have a Chinese variant. A function runtime's body is
 * documentation and stays English only.
 *
 * The plugin templates are checked without a lock: they ship no Chinese
 * variant, and a plugin made from them must start out English.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { readPlainYamlFrontmatter } from "../../packages/plugin-loader/src/plain-yaml-frontmatter.ts";
import { runtimeDirectoryDiagnostics } from "../../packages/plugin-loader/src/runtime-directory.ts";
import { promptStyleFindings, structureDifferences } from "./prompt-style.mjs";

/** `zh`, `zh-CN`, `zh-Hans`; not `zh-Hant` or `zh-TW`, which read English. */
function isSimplifiedChinese(tag) {
  try {
    const locale = new Intl.Locale(tag).maximize();
    return locale.language === "zh" && locale.script === "Hans";
  } catch {
    return false;
  }
}

/** A prompt counts as Chinese when CJK characters are a visible share of it. */
function isChinese(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const cjk = prose.match(/[一-鿿]/g)?.length ?? 0;
  return prose.trim().length > 0 && cjk / prose.length > 0.15;
}

function parsePromptFile(file) {
  const text = readFileSync(file, "utf8");
  return readPlainYamlFrontmatter(text);
}

function digest(text) {
  // Reformatting must not look like a content change.
  return createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

function staticPrompts(data) {
  return (data?.contributes?.prompt ?? [])
    .map((segment) =>
      typeof segment?.content === "string" ? segment.content : "",
    )
    .join("\n");
}

/** Every prompt file pair of one plugin: the root file and each runtime. */
function promptDirs(pluginRoot, problems) {
  const dirs = [{ dir: pluginRoot, stem: "PLUGIN" }];
  const runtimes = path.join(pluginRoot, "runtimes");
  if (existsSync(runtimes))
    for (const entry of readdirSync(runtimes, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(runtimes, entry.name);
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((file) => file.isFile() || file.isSymbolicLink())
        .map((file) => file.name);
      const diagnostic = runtimeDirectoryDiagnostics(dir, files);
      if (diagnostic.error || diagnostic.warning)
        problems.push(diagnostic.error ?? diagnostic.warning);
      if (files.includes("RUNTIME.md")) dirs.push({ dir, stem: "RUNTIME" });
    }
  return dirs.filter(({ dir, stem }) =>
    existsSync(path.join(dir, `${stem}.md`)),
  );
}

/**
 * Templates a plugin loads with `createPromptLoader` from its own `prompts/`
 * directory follow the same rule: `<name>.md` and a `<name>.zh.md` variant.
 */
function unreadTemplateVariants(pluginRoot, labelRoot) {
  const root = path.join(pluginRoot, "prompts");
  if (!existsSync(root)) return [];
  const problems = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      const tag = /^[^.]+\.([^.]+)\.md$/.exec(entry.name)?.[1];
      if (entry.isFile() && tag && !isSimplifiedChinese(tag))
        problems.push(
          `${path.relative(labelRoot, full)}: not read. A plugin's prompt templates exist only as the English <name>.md and a Simplified Chinese <name>.zh.md.`,
        );
    }
  };
  walk(root);
  return problems.sort();
}

/** Whether a model reads this file: an agent body or a static prompt segment. */
function isModelPrompt(data, stem) {
  if ((data?.contributes?.prompt ?? []).length > 0) return true;
  const runtime = stem === "PLUGIN" ? data?.runtime : data;
  // A runtime without a `function` block is an agent: its body is a prompt.
  return runtime !== undefined && runtime?.function === undefined;
}

function toolNames(data) {
  const names = [];
  const collect = (tools) => {
    for (const key of ["builtin", "plugin"])
      for (const name of tools?.[key] ?? []) names.push(name);
  };
  for (const name of data?.contributes?.tools ?? []) names.push(name);
  const runtime = data?.runtime ?? data;
  collect(runtime?.agent?.tools);
  collect(runtime?.function?.tools);
  return names;
}

/**
 * Injected block tags a prompt refers to: a tag written on its own in
 * backticks, or one with a closing tag. A placeholder inside a longer format
 * string is not a block.
 */
function blockTags(text) {
  const tags = new Set();
  for (const [, tag] of text.matchAll(/`(<[a-z][a-z0-9-]*>)`/g)) tags.add(tag);
  for (const [, name] of text.matchAll(/<\/([a-z][a-z0-9-]*)>/g))
    tags.add(`<${name}>`);
  return tags;
}

/**
 * Identifiers a prompt refers to that must survive translation unchanged:
 * tool names, bound inputs, and the block tags either language marks up.
 */
function identifiers(text, tags, knownTools) {
  const found = new Set();
  for (const tool of knownTools) {
    const pattern = new RegExp(
      `(?<![\\w-])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    );
    if (pattern.test(text)) found.add(tool);
  }
  for (const tag of tags) if (text.includes(tag)) found.add(tag);
  for (const [reference] of text.matchAll(/runtime-inputs\.[A-Za-z][\w-]*/g))
    found.add(reference);
  return found;
}

/**
 * @param {{ pluginsDir: string, lockPath?: string, write?: boolean, requireChinese?: boolean, labelRoot?: string }} options
 * @returns {{ problems: string[], warnings: string[], pairs: Record<string, { en: string, zh: string }> }}
 */
export function checkPromptVariants({
  pluginsDir,
  lockPath,
  write = false,
  requireChinese = false,
  labelRoot = path.dirname(pluginsDir),
}) {
  const plugins = readdirSync(pluginsDir)
    .filter((name) => !name.startsWith("_") && !name.startsWith("."))
    .map((name) => path.join(pluginsDir, name))
    .filter((dir) => statSync(dir).isDirectory())
    .sort();

  const problems = plugins.flatMap((plugin) =>
    unreadTemplateVariants(plugin, labelRoot),
  );
  const directories = new Map(
    plugins.map((plugin) => [plugin, promptDirs(plugin, problems)]),
  );

  // Tool names any bundled prompt may mention, plus the builtin completion tool.
  const knownTools = new Set(["runtime-done"]);
  for (const plugin of plugins)
    for (const { dir, stem } of directories.get(plugin))
      for (const name of toolNames(
        parsePromptFile(path.join(dir, `${stem}.md`)).data,
      ))
        knownTools.add(name);

  // Style of the English contract zone, and structure the two languages do
  // not share. They do not fail the check: see docs/plugins/prompt-style.md.
  const warnings = [];
  const pairs = {};

  for (const plugin of plugins) {
    for (const { dir, stem } of directories.get(plugin)) {
      const canonicalPath = path.join(dir, `${stem}.md`);
      const label = path.relative(labelRoot, canonicalPath);
      const canonical = parsePromptFile(canonicalPath);

      if (isChinese(canonical.body) || isChinese(staticPrompts(canonical.data)))
        problems.push(
          `${label}: the canonical prompt must be English. Move the Chinese text to ${stem}.zh.md.`,
        );

      const variants = readdirSync(dir).filter(
        (name) =>
          name.startsWith(`${stem}.`) &&
          name.endsWith(".md") &&
          name !== `${stem}.md`,
      );
      for (const name of variants) {
        const tag = name.slice(stem.length + 1, -3);
        if (!isSimplifiedChinese(tag))
          problems.push(
            `${path.relative(labelRoot, path.join(dir, name))}: not read. Prompt files exist only as the English canonical file and a Simplified Chinese (*.zh.md) variant.`,
          );
      }

      if (isModelPrompt(canonical.data, stem))
        for (const finding of promptStyleFindings(canonical.body))
          warnings.push(
            `${label}:${finding.line}: [${finding.rule}] ${finding.message}`,
          );

      const chinesePath = path.join(dir, `${stem}.zh.md`);
      if (!existsSync(chinesePath)) {
        if (requireChinese && isModelPrompt(canonical.data, stem))
          problems.push(
            `${label}: a model reads this prompt, so a bundled plugin must also ship ${stem}.zh.md.`,
          );
        continue;
      }
      const chinese = parsePromptFile(chinesePath);
      const english = `${canonical.body}\n${staticPrompts(canonical.data)}`;
      const translated = `${chinese.body}\n${staticPrompts(chinese.data)}`;

      const tags = new Set([...blockTags(english), ...blockTags(translated)]);
      const inEnglish = identifiers(english, tags, knownTools);
      const inChinese = identifiers(translated, tags, knownTools);
      const onlyEnglish = [...inEnglish].filter((id) => !inChinese.has(id));
      const onlyChinese = [...inChinese].filter((id) => !inEnglish.has(id));
      if (onlyEnglish.length > 0)
        problems.push(
          `${label}: named in English but not in ${stem}.zh.md: ${onlyEnglish.join(", ")}`,
        );
      if (onlyChinese.length > 0)
        problems.push(
          `${label}: named in ${stem}.zh.md but not in English: ${onlyChinese.join(", ")}`,
        );

      for (const difference of structureDifferences(
        canonical.body,
        chinese.body,
      ))
        warnings.push(`${label}: [structure] ${difference}`);

      pairs[label] = { en: digest(english), zh: digest(translated) };
    }
  }

  if (!lockPath) return { problems, warnings, pairs };
  if (write) {
    writeFileSync(lockPath, `${JSON.stringify(pairs, null, 2)}\n`);
  } else {
    const locked = existsSync(lockPath)
      ? JSON.parse(readFileSync(lockPath, "utf8"))
      : {};
    for (const [label, current] of Object.entries(pairs)) {
      const before = locked[label];
      if (!before) {
        problems.push(
          `${label}: new Chinese variant. Run \`pnpm prompts:lock\` to record it.`,
        );
      } else if (before.en !== current.en && before.zh === current.zh) {
        problems.push(
          `${label}: the English prompt changed and the Chinese variant did not. Update the .zh.md file, then run \`pnpm prompts:lock\`.`,
        );
      } else if (before.en !== current.en || before.zh !== current.zh) {
        problems.push(
          `${label}: the pair changed. Confirm both languages still say the same thing, then run \`pnpm prompts:lock\`.`,
        );
      }
    }
    for (const label of Object.keys(locked))
      if (!pairs[label])
        problems.push(
          `${label}: listed in the lock but has no Chinese variant. Run \`pnpm prompts:lock\`.`,
        );
  }

  return { problems, warnings, pairs };
}
