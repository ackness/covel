/**
 * Keep each plugin prompt and its Chinese variant from drifting apart.
 *
 * The canonical `PLUGIN.md` / `RUNTIME.md` is English and is the source of
 * truth. `*.zh.md` is a translation of it. A translation goes stale silently:
 * the English prompt changes, the Chinese one keeps an old instruction, and
 * Chinese sessions behave differently. Three checks make that visible:
 *
 *   1. The canonical prompt is English; only Simplified Chinese variants
 *      (`*.zh.md`) exist.
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
import YAML from "yaml";

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
  // The block may be empty; try that reading first so a `---` rule further
  // down the body is never taken for the closing fence.
  const match = /^---\n(?:([\s\S]*?)\n)??---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  return { data: YAML.parse(match[1] ?? "") ?? {}, body: match[2] };
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
function promptDirs(pluginRoot) {
  const dirs = [{ dir: pluginRoot, stem: "PLUGIN" }];
  const runtimes = path.join(pluginRoot, "runtimes");
  if (existsSync(runtimes))
    for (const name of readdirSync(runtimes).sort()) {
      const dir = path.join(runtimes, name);
      if (statSync(dir).isDirectory()) dirs.push({ dir, stem: "RUNTIME" });
    }
  return dirs.filter(({ dir, stem }) =>
    existsSync(path.join(dir, `${stem}.md`)),
  );
}

/** Whether a model reads this file: an agent body or a static prompt segment. */
function isModelPrompt(data, stem) {
  if ((data?.contributes?.prompt ?? []).length > 0) return true;
  const runtime = stem === "PLUGIN" ? data?.runtime : data;
  return runtime !== undefined && (runtime?.type ?? "agent") === "agent";
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
 * @returns {{ problems: string[], pairs: Record<string, { en: string, zh: string }> }}
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

  // Tool names any bundled prompt may mention, plus the builtin completion tool.
  const knownTools = new Set(["runtime-done"]);
  for (const plugin of plugins)
    for (const { dir, stem } of promptDirs(plugin))
      for (const name of toolNames(
        parsePromptFile(path.join(dir, `${stem}.md`)).data,
      ))
        knownTools.add(name);

  const problems = [];
  const pairs = {};

  for (const plugin of plugins) {
    for (const { dir, stem } of promptDirs(plugin)) {
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

      pairs[label] = { en: digest(english), zh: digest(translated) };
    }
  }

  if (!lockPath) return { problems, pairs };
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

  return { problems, pairs };
}
