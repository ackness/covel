import { compareText } from "@covel/shared";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  applyLocaleOverlay,
  canonicalizeLocale,
  isKnownLocale,
  localeLanguage,
  type LocaleOverlayIssue,
} from "@covel/shared";
import { parse as parseYaml } from "yaml";
import { resolveContainedPath } from "./safe-path.js";

/** An overlay entry that was ignored, with the file it came from. */
export interface LocaleOverlayFileIssue extends LocaleOverlayIssue {
  /** Overlay file, relative to the root it was read from. */
  readonly file: string;
}

export interface LocaleOverlayFile {
  /** Canonical locale named by the file. */
  readonly locale: string;
  readonly path: string;
  /** Path relative to the root. */
  readonly file: string;
}

function parseStructured(file: string, text: string): unknown {
  return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

/**
 * The declared locale a translation file should have been named with, when
 * `tag` is only the language of it. A translation file uses the locale
 * exactly as `supportedLocales` writes it: `.en` would also answer a session
 * in any other region of that language, and a world would have two spellings
 * for one edition. A language the world declares as such (`fr`) is exact.
 */
export function exactLocaleFor(
  tag: string,
  declared: readonly string[],
): string | undefined {
  const lower = tag.toLowerCase();
  if (declared.some((locale) => locale.toLowerCase() === lower))
    return undefined;
  return declared.find(
    (locale) =>
      locale.toLowerCase() !== lower && localeLanguage(locale) === lower,
  );
}

/** A translation file named with a bare language instead of the declared locale. */
export interface MisnamedLocaleFile {
  /** Relative to the world directory. */
  readonly file: string;
  readonly tag: string;
  /** The declared locale the file should name. */
  readonly exact: string;
  /** The file name it should have, relative to the world directory. */
  readonly renamed: string;
}

/** The finding about a misnamed file, as the validator and the loader word it. */
export function misnamedLocaleMessage(item: MisnamedLocaleFile): string {
  return `\`${path.basename(item.file)}\` names its language as "${item.tag}", but the world declares "${item.exact}"`;
}

const BARE_LANGUAGE_FILE = /^(.+)\.([A-Za-z]{2,3})\.(md|ya?ml|json)$/;
const MAX_SCANNED_FILES = 5000;

/**
 * Every translation file of a world package that names a bare language where
 * the world declares a region (`WORLD.en.md` for `en-US`). The validator
 * reports them and the loader ignores them.
 */
export async function findMisnamedLocaleFiles(
  worldDir: string,
  declared: readonly string[],
): Promise<MisnamedLocaleFile[]> {
  const found: MisnamedLocaleFile[] = [];
  let scanned = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(worldDir, directory), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(relative);
        continue;
      }
      if (!entry.isFile() || ++scanned > MAX_SCANNED_FILES) continue;
      const match = BARE_LANGUAGE_FILE.exec(entry.name);
      if (!match) continue;
      const [, name, tag, extension] = match as unknown as [
        string,
        string,
        string,
        string,
      ];
      if (!isKnownLocale(tag)) continue;
      const exact = exactLocaleFor(tag, declared);
      if (!exact) continue;
      found.push({
        file: relative,
        tag,
        exact,
        renamed: path.join(directory, `${name}.${exact}.${extension}`),
      });
    }
  }
  await visit("");
  return found;
}

/**
 * Overlay files beside a main file: `<name>.<locale><ext>` in the same
 * directory, where `<locale>` is a canonical locale tag. Sorted by locale so
 * the compiled result does not depend on directory order. With `declared`,
 * a file that names only the language of a declared locale is left out.
 */
export async function findLocaleOverlays(
  root: string,
  relativePath: string,
  declared?: readonly string[],
): Promise<LocaleOverlayFile[]> {
  const parsed = path.parse(relativePath);
  const directory = await resolveContainedPath(root, parsed.dir || ".", {
    rejectSymlinks: true,
  });
  if (!directory) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const found: LocaleOverlayFile[] = [];
  for (const name of names) {
    if (
      !name.startsWith(`${parsed.name}.`) ||
      !name.endsWith(parsed.ext) ||
      name === parsed.base
    )
      continue;
    const tag = name.slice(
      parsed.name.length + 1,
      name.length - parsed.ext.length,
    );
    // `items.backup.yaml` is not a translation: the tag must be a language.
    const locale = canonicalizeLocale(tag);
    if (!locale || !isKnownLocale(locale)) continue;
    if (declared && exactLocaleFor(tag, declared)) continue;
    const file = path.join(parsed.dir, name);
    const resolved = await resolveContainedPath(root, file, {
      rejectSymlinks: true,
    });
    if (resolved) found.push({ locale, path: resolved, file });
  }
  return found.sort((a, b) => compareText(a.locale, b.locale));
}

/**
 * The overlay a session of `locale` reads: the file named with that locale.
 * A session locale is an edition the world declares (`sessionContentLocale`),
 * so no other spelling is tried.
 */
export function pickLocaleOverlay(
  overlays: readonly LocaleOverlayFile[],
  locale: string | undefined,
): LocaleOverlayFile | undefined {
  const wanted = canonicalizeLocale(locale)?.toLowerCase();
  return wanted
    ? overlays.find((overlay) => overlay.locale.toLowerCase() === wanted)
    : undefined;
}

/**
 * Compile every overlay beside a structured file into locale maps: the form
 * a world's labels have in the catalog, where each viewer picks a language.
 */
export async function compileLocaleOverlays(args: {
  readonly root: string;
  readonly relativePath: string;
  readonly base: unknown;
  /** Locale of the main file. */
  readonly baseLocale: string | undefined;
  readonly arrayKey?: string;
  /** The world's locales; a file naming only the language of one is left out. */
  readonly declared?: readonly string[];
}): Promise<{
  value: unknown;
  overlays: readonly LocaleOverlayFile[];
  issues: LocaleOverlayFileIssue[];
}> {
  const overlays = await findLocaleOverlays(
    args.root,
    args.relativePath,
    args.declared,
  );
  const issues: LocaleOverlayFileIssue[] = [];
  let value = args.base;
  for (const overlay of overlays) {
    let parsed: unknown;
    try {
      parsed = parseStructured(
        overlay.path,
        await readFile(overlay.path, "utf-8"),
      );
    } catch (error) {
      issues.push({
        file: overlay.file,
        path: "(root)",
        message: `cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const merged = applyLocaleOverlay(value, parsed, {
      mode: "compile",
      locale: overlay.locale,
      baseLocale: args.baseLocale ?? DEFAULT_LOCALE,
      arrayKey: args.arrayKey,
    });
    value = merged.value;
    issues.push(
      ...merged.issues.map((issue) => ({ ...issue, file: overlay.file })),
    );
  }
  return { value, overlays, issues };
}

/**
 * Read `world.yaml` with every `world.<locale>.yaml` overlay compiled in. The
 * main file is written in the world's default locale; the result has locale
 * maps wherever an overlay translates a text.
 */
export async function readWorldManifestSource(worldDir: string): Promise<{
  /** `world.yaml` with its overlays compiled in. */
  raw: unknown;
  /** `world.yaml` alone, as written. */
  base: unknown;
  overlays: readonly LocaleOverlayFile[];
  issues: LocaleOverlayFileIssue[];
}> {
  const base: unknown = parseYaml(
    await readFile(path.join(worldDir, "world.yaml"), "utf-8"),
  );
  const baseLocale =
    base !== null &&
    typeof base === "object" &&
    typeof (base as { defaultLocale?: unknown }).defaultLocale === "string"
      ? (base as { defaultLocale: string }).defaultLocale
      : undefined;
  const supported = (base as { supportedLocales?: unknown } | null)
    ?.supportedLocales;
  const declared = [
    ...new Set(
      [baseLocale, ...(Array.isArray(supported) ? supported : [])].flatMap(
        (item) =>
          typeof item === "string" && canonicalizeLocale(item)
            ? [canonicalizeLocale(item)!]
            : [],
      ),
    ),
  ];
  const compiled = await compileLocaleOverlays({
    root: worldDir,
    relativePath: "world.yaml",
    base,
    baseLocale,
    declared,
  });
  return {
    raw: compiled.value,
    base,
    overlays: compiled.overlays,
    issues: compiled.issues,
  };
}
