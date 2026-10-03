import fs from "node:fs/promises";
import path from "node:path";
import { isLocaleMap } from "@covel/shared";
import { readLocaleFiles } from "./locale-files.js";

/** Language of a plugin's main files: manifests, prompts and UI specs. */
export const PLUGIN_BASE_LOCALE = "en";

/**
 * Translations of the text in a plugin's UI specs.
 *
 * A UI spec is a tree: its nodes have no ids a translation could be merged
 * on. So the spec holds the English text, and `locales/<locale>.yaml` holds a
 * flat `messages` section from that English text to its translation.
 *
 * ```yaml
 * # locales/zh.yaml
 * messages:
 *   Codex: 知识图鉴
 *   shortLabel|Codex: 图鉴
 *   "{{count}} entries collected": 已收录 {{count}} 条
 * ```
 *
 * A key may start with a property name and `|`. That entry applies to that
 * property only, for the case where one English text needs two translations.
 *
 * The loader compiles the translations into locale maps on the spec, the form
 * the client already resolves by UI language. A translation whose English text
 * changed no longer matches: the text is shown in English and
 * `pnpm validate:plugin` reports the entry.
 */
export interface MessageCatalog {
  readonly locale: string;
  /** Path of the locale file, relative to the plugin root. */
  readonly file: string;
  readonly messages: Readonly<Record<string, string>>;
}

/** Section of a locale file that holds the message catalog. */
export const MESSAGES_SECTION = "messages";

const TEXT_PROPERTIES: ReadonlySet<string> = new Set([
  "content",
  "description",
  "footer",
  "help",
  "hint",
  "label",
  "message",
  "placeholder",
  "subtitle",
  "summary",
  "text",
  "title",
  "tooltip",
]);
const TEXT_PROPERTY_SUFFIX =
  /(Description|Hint|Label|Message|Placeholder|Text|Title|Tooltip)$/;

/**
 * Whether a property of a UI spec holds text for the player. Translations
 * apply to these properties only, so a catalog cannot replace a component
 * name, an action or a data path.
 */
export function isTextProperty(name: string): boolean {
  return TEXT_PROPERTIES.has(name) || TEXT_PROPERTY_SUFFIX.test(name);
}

/**
 * Parts of a spec that hold data, not text for the player: action parameters
 * sent to a runtime, data sources, and maps from a component property to a
 * data path. A property there may be named `title` and still be data.
 */
function isDataSubtree(name: string): boolean {
  return name === "on" || name === "dataSource" || name.endsWith("PropMap");
}

/** Every text of a spec the player reads, with the property that holds it. */
function* uiTexts(
  value: unknown,
): Generator<{ property: string; text: string }> {
  if (Array.isArray(value)) {
    for (const item of value) yield* uiTexts(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [property, child] of Object.entries(value)) {
    if (isDataSubtree(property)) continue;
    if (typeof child === "string") {
      if (isTextProperty(property)) yield { property, text: child };
    } else yield* uiTexts(child);
  }
}

/**
 * The `messages` section of every locale file of the plugin, one catalog for
 * each locale, sorted by locale. An outside translation fills the entries
 * the author's file lacks.
 */
export async function readMessageCatalogs(
  pluginRoot: string,
): Promise<readonly MessageCatalog[]> {
  const catalogs = new Map<string, MessageCatalog>();
  for (const { locale, file, document } of await readLocaleFiles(pluginRoot)) {
    const section = document[MESSAGES_SECTION];
    if (section === null || typeof section !== "object") continue;
    const messages: Record<string, string> = {
      ...catalogs.get(locale)?.messages,
    };
    for (const [text, translation] of Object.entries(section))
      if (typeof translation === "string") messages[text] = translation;
    catalogs.set(locale, { locale, file, messages });
  }
  return [...catalogs.values()].sort((a, b) =>
    a.locale.localeCompare(b.locale),
  );
}

/** The catalog key that translates `text` at `property`, if any. */
function matchingKey(
  catalog: MessageCatalog,
  property: string,
  text: string,
): string | undefined {
  const scoped = `${property}|${text}`;
  if (Object.hasOwn(catalog.messages, scoped)) return scoped;
  return Object.hasOwn(catalog.messages, text) ? text : undefined;
}

/**
 * Compile translations into a UI spec. Every text property whose English
 * text has a translation becomes a locale map. `used`, when given, collects
 * `<file>\0<key>` for each catalog entry that was applied.
 */
export function compileUiText<T>(
  spec: T,
  catalogs: readonly MessageCatalog[],
  used?: Set<string>,
): T {
  if (catalogs.length === 0) return spec;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [property, child] of Object.entries(value)) {
      if (isDataSubtree(property)) {
        result[property] = child;
        continue;
      }
      if (typeof child !== "string" || !isTextProperty(property)) {
        result[property] = walk(child);
        continue;
      }
      const translated: Record<string, string> = {};
      for (const catalog of catalogs) {
        const key = matchingKey(catalog, property, child);
        if (key === undefined) continue;
        translated[catalog.locale] = catalog.messages[key]!;
        used?.add(`${catalog.file}\u0000${key}`);
      }
      result[property] =
        Object.keys(translated).length > 0
          ? { [PLUGIN_BASE_LOCALE]: child, ...translated }
          : child;
    }
    return result;
  };
  return walk(spec) as T;
}

/** Text properties of a spec that are written as an inline locale map. */
export function findInlineUiText(spec: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (isLocaleMap(value)) {
      found.push(at);
      return;
    }
    for (const [key, child] of Object.entries(value))
      walk(child, at ? `${at}.${key}` : key);
  };
  walk(spec, "");
  return found;
}

/** `{{name}}` and `{name}` placeholders of a text. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{?\s*[\w./-]+\s*\}?\}/g)]
    .map(([match]) => match.replace(/\s+/g, ""))
    .sort();
}

async function uiSpecFiles(pluginRoot: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, insideUi: boolean): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory())
        await visit(full, insideUi || entry.name === "ui");
      else if (insideUi && entry.isFile() && entry.name.endsWith(".json"))
        files.push(full);
    }
  };
  await visit(pluginRoot, false);
  return files;
}

const SOURCE_FILE = /\.(js|mjs|cjs|ts)$/;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "tests",
  "__tests__",
  "dist",
  "ui",
  "locales",
]);

async function sourceFiles(pluginRoot: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(full);
      } else if (
        entry.isFile() &&
        SOURCE_FILE.test(entry.name) &&
        !/\.test\.[a-z]+$/.test(entry.name)
      )
        files.push(full);
    }
  };
  await visit(pluginRoot);
  return files;
}

/**
 * A `translate(ctx, …)` or `labelText(ctx, …)` call up to its second argument.
 * A standalone plugin defines its own `translate`; the definition is no call.
 */
const TEXT_CALL =
  /(?<!function\s+)\b(translate|labelText)\(\s*[A-Za-z_$][\w$.?]*\s*,\s*(?:(["'])((?:\\.|(?!\2)[^\\\n])*)\2|(`)((?:\\.|[^\\`])*)`|([^\s"'`]))/g;

function unescapeLiteral(text: string): string {
  return text.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[\s\S])/g,
    (_, c) =>
      c === "n"
        ? "\n"
        : c === "t"
          ? "\t"
          : c[0] === "u"
            ? String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ""), 16))
            : c === "\n"
              ? ""
              : c,
  );
}

/**
 * The English texts that plugin code passes to `translate` and `labelText`,
 * and the calls whose text is not a constant. A catalog is keyed by the text,
 * so the text must be readable from the source.
 */
export function findCodeTexts(source: string): {
  texts: { line: number; text: string }[];
  dynamic: { line: number; call: string }[];
} {
  const texts: { line: number; text: string }[] = [];
  const dynamic: { line: number; call: string }[] = [];
  TEXT_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEXT_CALL.exec(source)) !== null) {
    const line = source.slice(0, match.index).split("\n").length;
    const [, call, , quoted, backtick, template] = match;
    if (quoted !== undefined)
      texts.push({ line, text: unescapeLiteral(quoted) });
    else if (backtick && !template!.includes("${"))
      texts.push({ line, text: unescapeLiteral(template!) });
    else dynamic.push({ line, call: call! });
  }
  return { texts, dynamic };
}

async function codeTexts(pluginRoot: string): Promise<{
  texts: { file: string; line: number; text: string }[];
  dynamic: { file: string; line: number; call: string }[];
}> {
  const texts: { file: string; line: number; text: string }[] = [];
  const dynamic: { file: string; line: number; call: string }[] = [];
  for (const full of await sourceFiles(pluginRoot)) {
    const file = path.relative(pluginRoot, full).split(path.sep).join("/");
    const found = findCodeTexts(await fs.readFile(full, "utf-8"));
    texts.push(...found.texts.map((item) => ({ file, ...item })));
    dynamic.push(...found.dynamic.map((item) => ({ file, ...item })));
  }
  return { texts, dynamic };
}

/**
 * Texts of a plugin, in its UI specs and its code, that have no translation
 * in `locale`. A text with no letters (a symbol, a number) needs none. An
 * entry that repeats the English text states that the text is the same in
 * that language.
 */
export async function missingTranslations(
  pluginRoot: string,
  locale: string,
): Promise<{ file: string; where: string; text: string }[]> {
  const catalogs = (await readMessageCatalogs(pluginRoot)).filter(
    (catalog) => catalog.locale === locale,
  );
  const missing: { file: string; where: string; text: string }[] = [];
  for (const full of await uiSpecFiles(pluginRoot)) {
    let spec: unknown;
    try {
      spec = JSON.parse(await fs.readFile(full, "utf-8"));
    } catch {
      continue;
    }
    const file = path.relative(pluginRoot, full).split(path.sep).join("/");
    for (const { property, text } of uiTexts(spec))
      if (
        /\p{L}/u.test(text) &&
        !catalogs.some(
          (catalog) => matchingKey(catalog, property, text) !== undefined,
        )
      )
        missing.push({ file, where: property, text });
  }
  for (const { file, line, text } of (await codeTexts(pluginRoot)).texts)
    if (
      /\p{L}/u.test(text) &&
      !catalogs.some((catalog) => Object.hasOwn(catalog.messages, text))
    )
      missing.push({ file, where: `line ${line}`, text });
  return missing;
}

/**
 * Static check of a plugin's message catalogs, for `pnpm validate:plugin`.
 * The loader shows English for a translation it cannot place; here each of
 * these is an error.
 */
export async function validatePluginMessages(
  pluginRoot: string,
): Promise<string[]> {
  const problems: string[] = [];
  const catalogs = await readMessageCatalogs(pluginRoot);
  const used = new Set<string>();

  for (const file of await uiSpecFiles(pluginRoot)) {
    const relative = path.relative(pluginRoot, file).split(path.sep).join("/");
    let spec: unknown;
    try {
      spec = JSON.parse(await fs.readFile(file, "utf-8"));
    } catch {
      continue; // Reported when the spec is loaded.
    }
    const inline = findInlineUiText(spec);
    if (inline.length > 0)
      problems.push(
        `${relative}: ${inline.length} text(s) written as a locale map (${inline
          .slice(0, 3)
          .join(
            ", ",
          )}). Write the English text here and the translations in locales/<locale>.yaml under "${MESSAGES_SECTION}".`,
      );
    compileUiText(spec, catalogs, used);
  }

  const code = await codeTexts(pluginRoot);
  for (const { file, line, call } of code.dynamic)
    problems.push(
      `${file}:${line}: ${call}() needs the English text as a constant; put values in {name} placeholders and pass them as parameters`,
    );
  for (const { text } of code.texts)
    for (const catalog of catalogs)
      if (Object.hasOwn(catalog.messages, text))
        used.add(`${catalog.file}\u0000${text}`);

  for (const catalog of catalogs)
    for (const [key, translation] of Object.entries(catalog.messages)) {
      if (!used.has(`${catalog.file}\u0000${key}`)) {
        problems.push(
          `${catalog.file}: ${MESSAGES_SECTION}: "${key}" is not a text of this plugin's UI or code; the English text changed or was removed, so this translation is ignored`,
        );
        continue;
      }
      // A `property|` prefix has no braces, so the key gives the source's set.
      const source = placeholders(key);
      const target = placeholders(translation);
      if (target.join() !== source.join())
        problems.push(
          `${catalog.file}: ${MESSAGES_SECTION}: "${key}" has placeholders ${source.join(" ") || "(none)"} and its translation has ${target.join(" ") || "(none)"}`,
        );
    }
  return problems;
}
