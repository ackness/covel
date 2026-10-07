/**
 * What a translator of a world package works on: which texts each file has,
 * which a language lacks, and how to write translations into the locale
 * files (`<name>.<locale>.<ext>` beside each main file).
 *
 * A world's data has no schema that marks which strings are text. A string
 * counts as text by what it looks like: in a world written in Chinese,
 * Japanese or Korean, a string with characters of that script; in any other
 * world, a string under a field that is not an identifier, with a space or a
 * capital letter. The result is a guide for a translator, not a gate.
 *
 * Dimension files are the exception: their schema says what is text. A
 * definition's name, description and update rule, a node's title and enum
 * labels, and a value at a node marked `x-i18n`. A value at any other node is
 * never localized, so a translation there would make the file invalid.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_LOCALE, validateWorldManifest } from "@covel/shared";
import { worldHasData } from "./conventions.js";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { findLocaleOverlays } from "./locale-overlays.js";
import { fileExists } from "./session-import/utils.js";

/** One step from a file's root to a text: a key, a list item by id, or by position. */
export type WorldTextStep =
  | string
  | { readonly by: string; readonly value: string | number }
  | { readonly index: number };

export interface WorldTextUnit {
  /** The main file, relative to the world directory. */
  readonly file: string;
  /** Stable id of the unit: `<file>#<pointer>`. */
  readonly id: string;
  readonly steps: readonly WorldTextStep[];
  readonly pointer: string;
  readonly text: string;
  /** The whole file is one text (lore, a prose source). */
  readonly prose?: true;
}

export interface WorldFileTranslationStatus {
  readonly file: string;
  /** The locale file that holds, or would hold, the translations. */
  readonly localeFile: string;
  readonly total: number;
  readonly missing: readonly WorldTextUnit[];
  /**
   * Short texts the language already translates, with their translations:
   * names and terms a later translation must use the same way.
   */
  readonly terms: readonly {
    readonly source: string;
    readonly target: string;
  }[];
  /**
   * Dimension values that read as text and cannot be translated: their
   * schema node is not marked `x-i18n`. Every session shows them as written.
   */
  readonly notTranslatable?: readonly string[];
}

export interface WorldTranslationStatus {
  readonly baseLocale: string;
  readonly locale: string;
  readonly files: readonly WorldFileTranslationStatus[];
}

interface StructuredFile {
  readonly file: string;
  readonly format: "yaml" | "json";
  readonly arrayKeys: readonly string[];
  readonly value: unknown;
  /** A world dimensions file: its schema says what is text. */
  readonly dimensions?: true;
  /** Places whose string is never text, whatever it looks like. */
  readonly notText?: ReadonlySet<string>;
}

/**
 * Manifest fields that stay as written in every language. An author's name and
 * a license name look like text, but the manifest takes one string for each,
 * so a translation there would make the file invalid.
 */
const MANIFEST_NOT_TEXT: ReadonlySet<string> = new Set([
  "author.name",
  "license",
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ids",
  "key",
  "type",
  "kind",
  "category",
  "position",
  "strategy",
  "icon",
  "color",
  "status",
  "slot",
  "schema",
  "path",
  "to",
  "from",
  "source",
  "after",
  "format",
  "mime",
  "filename",
  "file",
  "characterId",
  "sceneId",
  "worldData",
  "defaultLocale",
  "presetId",
  "version",
  "budgetClass",
  "owner",
]);

function isText(key: string, text: string, baseLocale: string): boolean {
  if (!text.trim()) return false;
  if (/^(zh|ja|ko)([-_]|$)/i.test(baseLocale)) return CJK.test(text);
  if (IDENTIFIER_KEYS.has(key) || key.endsWith("Id") || key.endsWith("Ref"))
    return false;
  return (
    /\p{L}/u.test(text) && (/\s/.test(text.trim()) || /^\p{Lu}/u.test(text))
  );
}

function elementKey(
  items: readonly unknown[],
  keys: readonly string[],
): string | undefined {
  if (items.length === 0) return undefined;
  return keys.find((key) =>
    items.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        ["string", "number"].includes(
          typeof (item as Record<string, unknown>)[key],
        ),
    ),
  );
}

function pointerOf(steps: readonly WorldTextStep[]): string {
  return steps
    .map((step, index) =>
      typeof step === "string"
        ? `${index === 0 ? "" : "."}${step}`
        : "by" in step
          ? `[${step.by}=${step.value}]`
          : `[${step.index}]`,
    )
    .join("");
}

function textUnits(
  source: StructuredFile,
  baseLocale: string,
): WorldTextUnit[] {
  const units: WorldTextUnit[] = [];
  const add = (steps: readonly WorldTextStep[], text: string) => {
    const pointer = pointerOf(steps);
    units.push({
      file: source.file,
      id: `${source.file}#${pointer}`,
      steps,
      pointer,
      text,
    });
  };
  const walk = (
    value: unknown,
    steps: readonly WorldTextStep[],
    key: string,
  ): void => {
    if (typeof value === "string") {
      if (source.notText?.has(pointerOf(steps))) return;
      if (isText(key, value, baseLocale)) add(steps, value);
      return;
    }
    if (Array.isArray(value)) {
      // A list of plain texts is one unit: the locale file replaces the whole
      // list. When one item is text, every item with a letter is translated
      // (trigger words: `storm` beside `Crownfire`).
      if (
        value.every((item) => typeof item === "string") &&
        value.some((item) => isText(key, item as string, baseLocale))
      ) {
        value.forEach((item, index) => {
          if (/\p{L}/u.test(item as string))
            add([...steps, { index }], item as string);
        });
        return;
      }
      const by = elementKey(value, source.arrayKeys);
      value.forEach((item, index) =>
        walk(
          item,
          [
            ...steps,
            by
              ? { by, value: (item as Record<string, string | number>)[by]! }
              : { index },
          ],
          key,
        ),
      );
      return;
    }
    if (value === null || typeof value !== "object") return;
    const identity = steps.at(-1);
    for (const [name, child] of Object.entries(value)) {
      if (
        typeof identity === "object" &&
        "by" in identity &&
        name === identity.by
      )
        continue;
      walk(child, [...steps, name], name);
    }
  };
  walk(source.value, [], "");
  return units;
}

type SchemaNode = Readonly<Record<string, unknown>>;

/**
 * The texts of a dimensions file, by its schema. `blocked` collects the
 * pointers of values that read as text at nodes that are not `x-i18n`.
 */
function dimensionUnits(
  source: StructuredFile,
  baseLocale: string,
  blocked: string[],
): WorldTextUnit[] {
  const units: WorldTextUnit[] = [];
  // The schema says the place holds text. Text with nothing to translate
  // ("ID" in a Chinese world, a number) still needs no entry.
  const cjkBase = /^(zh|ja|ko)([-_]|$)/i.test(baseLocale);
  const add = (steps: readonly WorldTextStep[], text: unknown) => {
    if (typeof text !== "string") return;
    if (cjkBase ? !CJK.test(text) : !/\p{L}/u.test(text)) return;
    const pointer = pointerOf(steps);
    units.push({
      file: source.file,
      id: `${source.file}#${pointer}`,
      steps,
      pointer,
      text,
    });
  };
  const labels = (node: unknown, steps: readonly WorldTextStep[]): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node))
      return;
    const schema = node as SchemaNode;
    add([...steps, "title"], schema.title);
    const enumLabels = schema["x-enumLabels"];
    if (enumLabels !== null && typeof enumLabels === "object")
      for (const [member, label] of Object.entries(enumLabels))
        add([...steps, "x-enumLabels", member], label);
    if (schema.properties !== null && typeof schema.properties === "object")
      for (const [name, child] of Object.entries(schema.properties))
        labels(child, [...steps, "properties", name]);
    labels(schema.items, [...steps, "items"]);
    if (typeof schema.additionalProperties === "object")
      labels(schema.additionalProperties, [...steps, "additionalProperties"]);
  };
  const values = (
    node: unknown,
    value: unknown,
    steps: readonly WorldTextStep[],
  ): void => {
    const schema =
      node !== null && typeof node === "object" ? (node as SchemaNode) : {};
    if (typeof value === "string") {
      if (schema["x-i18n"] === true) add(steps, value);
      else if (!schema.enum && isText("", value, baseLocale))
        blocked.push(pointerOf(steps));
      return;
    }
    if (Array.isArray(value)) {
      const by = elementKey(value, source.arrayKeys);
      value.forEach((item, index) =>
        values(schema.items, item, [
          ...steps,
          by
            ? { by, value: (item as Record<string, string | number>)[by]! }
            : { index },
        ]),
      );
      return;
    }
    if (value === null || typeof value !== "object") return;
    const properties =
      schema.properties !== null && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    for (const [name, child] of Object.entries(value))
      values(
        properties[name] ??
          (typeof schema.additionalProperties === "object"
            ? schema.additionalProperties
            : undefined),
        child,
        [...steps, name],
      );
  };

  if (source.value === null || typeof source.value !== "object") return units;
  for (const [id, definition] of Object.entries(source.value)) {
    if (definition === null || typeof definition !== "object") continue;
    const { name, description, updateRule, schema, initialValue } =
      definition as Record<string, unknown>;
    add([id, "name"], name);
    add([id, "description"], description);
    add([id, "updateRule"], updateRule);
    labels(schema, [id, "schema"]);
    values(schema, initialValue, [id, "initialValue"]);
  }
  return units;
}

function valueAt(root: unknown, steps: readonly WorldTextStep[]): unknown {
  let current = root;
  for (const step of steps) {
    if (current === null || typeof current !== "object") return undefined;
    if (typeof step === "string")
      current = (current as Record<string, unknown>)[step];
    else if (!Array.isArray(current)) return undefined;
    else if ("by" in step)
      current = current.find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          (item as Record<string, unknown>)[step.by] === step.value,
      );
    else current = current[step.index];
  }
  return current;
}

/**
 * Put translations into an overlay that mirrors the main value. A list of
 * plain texts is translated as a whole: the overlay's list replaces the main
 * one, so it is written only when every item has a translation.
 */
function buildOverlay(
  main: unknown,
  existing: unknown,
  translations: ReadonlyMap<string, string>,
  source: StructuredFile,
  steps: readonly WorldTextStep[],
): unknown {
  if (typeof main === "string") {
    const translated = translations.get(`${source.file}#${pointerOf(steps)}`);
    return translated ?? (typeof existing === "string" ? existing : undefined);
  }
  if (Array.isArray(main)) {
    const by = elementKey(main, source.arrayKeys);
    if (by) {
      const items = main.flatMap((item) => {
        const id = (item as Record<string, string | number>)[by]!;
        const previous = Array.isArray(existing)
          ? existing.find(
              (entry) =>
                entry !== null &&
                typeof entry === "object" &&
                (entry as Record<string, unknown>)[by] === id,
            )
          : undefined;
        const overlay = buildOverlay(item, previous, translations, source, [
          ...steps,
          { by, value: id },
        ]) as Record<string, unknown> | undefined;
        return overlay ? [{ [by]: id, ...overlay }] : [];
      });
      return items.length > 0 ? items : undefined;
    }
    if (main.every((item) => typeof item === "string")) {
      const items = main.map((item, index) =>
        buildOverlay(
          item,
          Array.isArray(existing) ? existing[index] : undefined,
          translations,
          source,
          [...steps, { index }],
        ),
      );
      // Untranslated identifiers in the list stay as they are.
      const complete = items.map((item, index) => item ?? main[index]);
      return items.some((item) => item !== undefined) ? complete : undefined;
    }
    // Items with no id are matched by position; `null` keeps the main item.
    const items = main.map((item, index) =>
      buildOverlay(
        item,
        Array.isArray(existing) ? existing[index] : undefined,
        translations,
        source,
        [...steps, { index }],
      ),
    );
    return items.some((item) => item !== undefined)
      ? items.map((item) => item ?? null)
      : undefined;
  }
  if (main === null || typeof main !== "object") return undefined;
  const result: Record<string, unknown> = {};
  const identity = steps.at(-1);
  for (const [name, child] of Object.entries(main)) {
    if (
      typeof identity === "object" &&
      "by" in identity &&
      name === identity.by
    )
      continue;
    const overlay = buildOverlay(
      child,
      existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
        ? (existing as Record<string, unknown>)[name]
        : undefined,
      translations,
      source,
      [...steps, name],
    );
    if (overlay !== undefined) result[name] = overlay;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function localeFileName(file: string, locale: string): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.${locale}${parsed.ext}`);
}

async function readStructured(
  worldDir: string,
  file: string,
): Promise<unknown> {
  const text = await readFile(path.join(worldDir, file), "utf-8");
  return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

interface WorldFiles {
  readonly baseLocale: string;
  readonly structured: readonly StructuredFile[];
  readonly prose: readonly string[];
}

/** The files of a world package that hold text, with the main value of each. */
async function worldFiles(worldDir: string): Promise<WorldFiles> {
  const manifest = (await readStructured(worldDir, "world.yaml")) as Record<
    string,
    unknown
  >;
  const validation = validateWorldManifest(manifest);
  const baseLocale =
    typeof manifest.defaultLocale === "string"
      ? manifest.defaultLocale
      : DEFAULT_LOCALE;
  const structured: StructuredFile[] = [
    {
      file: "world.yaml",
      format: "yaml",
      arrayKeys: ["id"],
      value: manifest,
      notText: MANIFEST_NOT_TEXT,
    },
  ];
  const prose: string[] = [];
  if (await fileExists(path.join(worldDir, "WORLD.md"))) prose.push("WORLD.md");

  const worldData =
    typeof manifest.worldData === "string" ? manifest.worldData : undefined;
  if (validation.valid && (await worldHasData(worldDir, worldData))) {
    const descriptor = await loadWorldDataDescriptor({
      worldRoot: worldDir,
      worldDataPath: worldData,
      worldId: String(manifest.id),
    });
    for (const source of descriptor.sources) {
      const { kind, path: file, key, localeArrayKeys = [] } = source.descriptor;
      if (source.inlineValue !== undefined || typeof file !== "string")
        continue;
      if (kind === "yaml" || kind === "json")
        structured.push({
          file,
          format: kind,
          arrayKeys: [
            ...new Set([...(key ? [key] : []), "id", ...localeArrayKeys]),
          ],
          value: await readStructured(worldDir, file),
          ...(source.descriptor.to === "world:metadata.dimensions"
            ? { dimensions: true as const }
            : {}),
        });
      else if (kind !== "media" && /\.(md|txt)$/.test(file)) prose.push(file);
    }
  }
  return { baseLocale, structured, prose };
}

async function overlayOf(
  worldDir: string,
  file: string,
  locale: string,
): Promise<{ file: string; path: string } | undefined> {
  const overlays = await findLocaleOverlays(worldDir, file);
  return (
    overlays.find((overlay) => overlay.locale === locale) ??
    overlays.find(
      (overlay) => overlay.locale.split("-")[0] === locale.split("-")[0],
    )
  );
}

/** What `locale` translates of the world, file by file, and what it lacks. */
export async function worldTranslationStatus(
  worldDir: string,
  locale: string,
): Promise<WorldTranslationStatus> {
  const { baseLocale, structured, prose } = await worldFiles(worldDir);
  const files: WorldFileTranslationStatus[] = [];
  for (const source of structured) {
    const blocked: string[] = [];
    const units = source.dimensions
      ? dimensionUnits(source, baseLocale, blocked)
      : textUnits(source, baseLocale);
    if (units.length === 0 && blocked.length === 0) continue;
    const overlay = await overlayOf(worldDir, source.file, locale);
    const translated = overlay
      ? await readStructured(worldDir, overlay.file)
      : undefined;
    const terms: { source: string; target: string }[] = [];
    const missing: WorldTextUnit[] = [];
    for (const unit of units) {
      const target = valueAt(translated, unit.steps);
      const last = unit.steps.at(-1);
      // A translated list of plain texts stands for the whole main list,
      // whatever its length: its items do not line up one to one.
      const inTranslatedList =
        typeof last === "object" &&
        "index" in last &&
        Array.isArray(valueAt(translated, unit.steps.slice(0, -1)));
      if (inTranslatedList) continue;
      if (typeof target !== "string") missing.push(unit);
      else if (unit.text.length <= 40 && target !== unit.text)
        terms.push({ source: unit.text, target });
    }
    files.push({
      file: source.file,
      localeFile: overlay?.file ?? localeFileName(source.file, locale),
      total: units.length,
      missing,
      terms,
      ...(blocked.length > 0 ? { notTranslatable: blocked } : {}),
    });
  }
  for (const file of prose) {
    const overlay = await overlayOf(worldDir, file, locale);
    const text = await readFile(path.join(worldDir, file), "utf-8");
    files.push({
      file,
      localeFile: overlay?.file ?? localeFileName(file, locale),
      total: 1,
      terms: [],
      missing: overlay
        ? []
        : [{ file, id: `${file}#`, steps: [], pointer: "", text, prose: true }],
    });
  }
  return { baseLocale, locale, files };
}

/**
 * Write translations into the world's locale files. `translations` maps a
 * unit id to its translation. A structured file gets an overlay with only the
 * translated text; a prose file is written whole. Returns the files written.
 */
export async function writeWorldTranslations(
  worldDir: string,
  locale: string,
  translations: ReadonlyMap<string, string>,
): Promise<string[]> {
  const { structured, prose } = await worldFiles(worldDir);
  const written: string[] = [];
  for (const source of structured) {
    if (
      ![...translations.keys()].some((id) => id.startsWith(`${source.file}#`))
    )
      continue;
    const existing = await overlayOf(worldDir, source.file, locale);
    const overlay = buildOverlay(
      source.value,
      existing ? await readStructured(worldDir, existing.file) : undefined,
      translations,
      source,
      [],
    );
    if (overlay === undefined) continue;
    const target = existing?.file ?? localeFileName(source.file, locale);
    await mkdir(path.dirname(path.join(worldDir, target)), { recursive: true });
    await writeFile(
      path.join(worldDir, target),
      source.format === "json"
        ? `${JSON.stringify(overlay, null, 2)}\n`
        : stringifyYaml(overlay, { lineWidth: 0 }),
    );
    written.push(target);
  }
  for (const file of prose) {
    const text = translations.get(`${file}#`);
    if (text === undefined) continue;
    const target =
      (await overlayOf(worldDir, file, locale))?.file ??
      localeFileName(file, locale);
    await writeFile(path.join(worldDir, target), `${text.trimEnd()}\n`);
    written.push(target);
  }
  return written;
}
