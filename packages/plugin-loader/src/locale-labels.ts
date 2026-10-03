import fs from "node:fs/promises";
import path from "node:path";
import {
  applyLocaleOverlay,
  canonicalizeLocale,
  findInlineLocaleMaps,
  isKnownLocale,
  type LocaleOverlayIssue,
} from "@covel/shared";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import {
  MESSAGES_SECTION,
  PLUGIN_BASE_LOCALE,
  validatePluginMessages,
} from "./locale-messages.js";

/**
 * Label translations of a plugin.
 *
 * `PLUGIN.md` and `RUNTIME.md` are written in English. The labels a player
 * sees (display names, descriptions, command and setting labels) are
 * translated in `locales/<locale>.yaml` at the plugin root: one file per
 * language, keyed by the file each part translates.
 *
 * ```yaml
 * # locales/zh.yaml
 * PLUGIN.md:
 *   displayName: 行囊
 *   contributes:
 *     commands:
 *       - name: bag
 *         description: 查看当前背包。
 * runtimes/ledger/RUNTIME.md:
 *   description: 记录物品得失。
 * ```
 *
 * The loader compiles them into locale maps on the manifest, the form the
 * client already resolves by UI language. Prompt text is not a label: it stays
 * in `PLUGIN.zh.md` / `RUNTIME.zh.md`.
 */
export interface ManifestLabels {
  readonly locale: string;
  /** Path of the locale file, relative to the plugin root. */
  readonly file: string;
  readonly overlay: unknown;
}

/** Lists in a manifest are matched by the first of these every element has. */
const MANIFEST_ARRAY_KEYS = ["id", "name", "key"] as const;

/**
 * The manifest fields that are labels. Everything else in a manifest is the
 * plugin's contract: ids, types, schedules, tool lists. A label file that
 * could reach those would let a translation change, or break, the plugin.
 */
const MANIFEST_LABEL_KEYS: ReadonlySet<string> = new Set([
  "displayName",
  "description",
  "label",
  "title",
  "summary",
]);

/** Keep label text and the fields list items are matched by; report the rest. */
function onlyLabels(
  value: unknown,
  path: string,
  key: string | undefined,
  inListItem: boolean,
  report: (path: string, message: string) => void,
): unknown {
  if (Array.isArray(value))
    return value.map((item, index) =>
      onlyLabels(item, `${path}[${index}]`, key, true, report),
    );
  if (value !== null && typeof value === "object") {
    const kept: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      const next = onlyLabels(
        child,
        path ? `${path}.${name}` : name,
        name,
        false,
        report,
      );
      if (next !== undefined) kept[name] = next;
      else if (
        inListItem &&
        (MANIFEST_ARRAY_KEYS as readonly string[]).includes(name)
      )
        kept[name] = child;
    }
    return kept;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && key && MANIFEST_LABEL_KEYS.has(key))
    return value;
  // The field a list item is matched by is kept by the caller above.
  if (!(
    key &&
    (MANIFEST_ARRAY_KEYS as readonly string[]).includes(key) &&
    (typeof value === "string" || typeof value === "number")
  ))
    report(
      path,
      `is not a label; a label file translates ${[...MANIFEST_LABEL_KEYS].join(", ")} only`,
    );
  return undefined;
}

/**
 * Labels for one manifest file (`PLUGIN.md`, `runtimes/<id>/RUNTIME.md`) from
 * every `locales/<locale>.yaml` of the plugin, sorted by locale.
 */
export async function readManifestLabels(
  pluginRoot: string,
  manifestFile: string,
): Promise<readonly ManifestLabels[]> {
  const directory = path.join(pluginRoot, "locales");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const key = manifestFile.split(path.sep).join("/");
  const labels: ManifestLabels[] = [];
  for (const name of names.sort()) {
    const tag = /^(.+)\.ya?ml$/.exec(name)?.[1];
    const locale = tag ? canonicalizeLocale(tag) : undefined;
    // `locales/notes.yaml` is not a translation: the name must be a language.
    if (!locale || !isKnownLocale(locale)) continue;
    const full = path.join(directory, name);
    // A link could point outside the plugin: read regular files only.
    if (!(await fs.lstat(full)).isFile()) continue;
    let document: unknown;
    try {
      document = parseYaml(await fs.readFile(full, "utf-8"));
    } catch (error) {
      // A broken translation file must not disable the plugin.
      console.warn(
        `[plugin-loader] ${full}: cannot be parsed, its labels are ignored - ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
      continue;
    }
    if (document === null || typeof document !== "object") continue;
    const overlay = (document as Record<string, unknown>)[key];
    if (overlay !== undefined && overlay !== null)
      labels.push({ locale, file: `locales/${name}`, overlay });
  }
  return labels;
}

/**
 * Compile label translations into a manifest's frontmatter. Returns the
 * frontmatter with locale maps at every translated label, and every entry
 * that could not be applied.
 */
export function compileManifestLabels(
  frontmatter: Readonly<Record<string, unknown>>,
  labels: readonly ManifestLabels[],
): {
  data: Record<string, unknown>;
  issues: (LocaleOverlayIssue & { file: string })[];
} {
  let data: unknown = frontmatter;
  const issues: (LocaleOverlayIssue & { file: string })[] = [];
  for (const { locale, file, overlay } of labels) {
    let entries = overlay;
    const prompt =
      overlay !== null && typeof overlay === "object"
        ? (overlay as { contributes?: { prompt?: unknown } }).contributes
            ?.prompt
        : undefined;
    if (prompt !== undefined) {
      // Prompt segments are instructions. They exist in English and Chinese
      // only and are chosen by the session's instruction language.
      issues.push({
        file,
        path: "contributes.prompt",
        message:
          "is prompt text, not a label; translate it in PLUGIN.zh.md, the instruction variant",
      });
      const { prompt: _dropped, ...contributes } = (
        overlay as { contributes: Record<string, unknown> }
      ).contributes;
      entries = { ...(overlay as Record<string, unknown>), contributes };
    }
    entries = onlyLabels(entries, "", undefined, false, (at, message) =>
      issues.push({ file, path: at, message }),
    );
    const merged = applyLocaleOverlay(data, entries, {
      mode: "compile",
      locale,
      baseLocale: PLUGIN_BASE_LOCALE,
      arrayKey: MANIFEST_ARRAY_KEYS,
    });
    data = merged.value;
    issues.push(...merged.issues.map((issue) => ({ ...issue, file })));
  }
  return { data: data as Record<string, unknown>, issues };
}

async function manifestFilesOf(pluginRoot: string): Promise<string[]> {
  const files = ["PLUGIN.md"];
  const runtimes = path.join(pluginRoot, "runtimes");
  let names: string[] = [];
  try {
    names = await fs.readdir(runtimes);
  } catch {
    return files;
  }
  for (const name of names.sort())
    if ((await fs.stat(path.join(runtimes, name))).isDirectory())
      files.push(`runtimes/${name}/RUNTIME.md`);
  return files;
}

/**
 * Static check of a plugin's locale files, for `pnpm validate:plugin`: the
 * label sections and the message catalog. The loader only warns about a
 * translation it cannot place, so that one stale entry does not disable a
 * plugin; here each of these is an error.
 */
export async function validatePluginLabels(
  pluginRoot: string,
): Promise<string[]> {
  const problems: string[] = [];
  const manifests = await manifestFilesOf(pluginRoot);

  for (const file of manifests) {
    let content: string;
    try {
      content = await fs.readFile(path.join(pluginRoot, file), "utf-8");
    } catch {
      continue;
    }
    const data = matter(content, { language: "yaml" }).data;
    // The main files hold one language. A translation written inline is not
    // read by translators or tools that work on `locales/`.
    const inline = findInlineLocaleMaps(data, PLUGIN_BASE_LOCALE);
    if (inline.length > 0)
      problems.push(
        `${file}: ${inline.length} label(s) written as a locale map (${inline
          .slice(0, 3)
          .map((item) => item.path)
          .join(
            ", ",
          )}). Write the English text here and the translations in locales/<locale>.yaml under "${file}".`,
      );
    for (const issue of compileManifestLabels(
      data,
      await readManifestLabels(pluginRoot, file),
    ).issues)
      problems.push(
        `${issue.file}: ${file}: ${issue.path} ${issue.message}; this translation is ignored`,
      );
  }

  // A section must name a manifest file of this plugin.
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(pluginRoot, "locales"));
  } catch {
    return [...problems, ...(await validatePluginMessages(pluginRoot))];
  }
  for (const name of names.sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const tag = name.replace(/\.ya?ml$/, "");
    if (!isKnownLocale(canonicalizeLocale(tag) ?? "")) {
      problems.push(
        `locales/${name}: "${tag}" is not a language tag; name the file after its locale, for example zh.yaml`,
      );
      continue;
    }
    let document: unknown;
    try {
      document = parseYaml(
        await fs.readFile(path.join(pluginRoot, "locales", name), "utf-8"),
      );
    } catch (error) {
      problems.push(
        `locales/${name}: cannot be parsed - ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
      continue;
    }
    if (document === null || typeof document !== "object") continue;
    for (const section of Object.keys(document))
      if (section !== MESSAGES_SECTION && !manifests.includes(section))
        problems.push(
          `locales/${name}: section "${section}" is not "${MESSAGES_SECTION}" or a manifest file of this plugin (${manifests.join(", ")})`,
        );
  }
  return [...problems, ...(await validatePluginMessages(pluginRoot))];
}
