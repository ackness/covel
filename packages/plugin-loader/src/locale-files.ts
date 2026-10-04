import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalizeLocale, isKnownLocale } from "@covel/shared";

/**
 * Where a plugin's text in other languages comes from.
 *
 * 1. `locales/<locale>.yaml` in the plugin: the author's translation.
 * 2. `<translations>/plugins/<pluginId>/<locale>.yaml`: a translation made
 *    outside the package. A translation package that the user installed and
 *    a machine translation made on this machine both live there, in the
 *    format of the author's file. It fills only what the author's file does
 *    not translate.
 *
 * The translations directory holds labels and messages only. A prompt body
 * (`*.zh.md`) is never read from it: an unreviewed translation of an
 * instruction is an unreviewed change of behavior.
 */
let translationsRoot: string | undefined;

/** Set the directory of translations made outside the packages; `undefined` turns it off. */
export function setTranslationsDirectory(directory: string | undefined): void {
  translationsRoot = directory ? path.resolve(directory) : undefined;
}

/** The directory that holds the outside translations of one plugin, if one is set. */
function translationsDirectoryOf(pluginRoot: string): string | undefined {
  // A plugin's id is the name of its directory.
  return translationsRoot
    ? path.join(translationsRoot, "plugins", path.basename(pluginRoot))
    : undefined;
}

export interface LocaleFile {
  readonly locale: string;
  /** The file as a message names it: `locales/zh.yaml`, or `translations/<id>/zh.yaml`. */
  readonly file: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly origin: "plugin" | "translations";
}

async function readDirectory(
  directory: string,
  label: string,
  origin: LocaleFile["origin"],
): Promise<LocaleFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const files: LocaleFile[] = [];
  for (const name of names.sort()) {
    const tag = /^(.+)\.ya?ml$/.exec(name)?.[1];
    const locale = tag ? canonicalizeLocale(tag) : undefined;
    // `locales/notes.yaml` is not a translation: the name must be a language.
    if (!locale || !isKnownLocale(locale)) continue;
    const full = path.join(directory, name);
    // A link could point outside the directory: read regular files only.
    if (!(await fs.lstat(full)).isFile()) continue;
    let document: unknown;
    try {
      document = parseYaml(await fs.readFile(full, "utf-8"));
    } catch (error) {
      // A broken translation file must not disable the plugin.
      console.warn(
        `[plugin-loader] ${full}: cannot be parsed, its text is ignored - ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
      continue;
    }
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document)
    )
      continue;
    files.push({
      locale,
      file: `${label}/${name}`,
      document: document as Record<string, unknown>,
      origin,
    });
  }
  return files;
}

/**
 * Every locale file of a plugin. The files of the translations directory
 * come first, so that a reader that applies the files in order ends with the
 * author's text wherever the author translated.
 */
export async function readLocaleFiles(
  pluginRoot: string,
): Promise<readonly LocaleFile[]> {
  const outside = translationsDirectoryOf(pluginRoot);
  return [
    ...(outside
      ? await readDirectory(
          outside,
          `translations/${path.basename(pluginRoot)}`,
          "translations",
        )
      : []),
    ...(await readDirectory(
      path.join(pluginRoot, "locales"),
      "locales",
      "plugin",
    )),
  ];
}
