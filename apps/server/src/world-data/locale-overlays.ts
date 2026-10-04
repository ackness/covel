import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  applyLocaleOverlay,
  canonicalizeLocale,
  isKnownLocale,
  localeLookupCandidates,
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
 * Overlay files beside a main file: `<name>.<locale><ext>` in the same
 * directory, where `<locale>` is a canonical locale tag. Sorted by locale so
 * the compiled result does not depend on directory order.
 */
export async function findLocaleOverlays(
  root: string,
  relativePath: string,
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
    const file = path.join(parsed.dir, name);
    const resolved = await resolveContainedPath(root, file, {
      rejectSymlinks: true,
    });
    if (resolved) found.push({ locale, path: resolved, file });
  }
  return found.sort((a, b) => a.locale.localeCompare(b.locale));
}

/** The overlay a session of `locale` reads: its exact tag, then its language. */
export function pickLocaleOverlay(
  overlays: readonly LocaleOverlayFile[],
  locale: string | undefined,
): LocaleOverlayFile | undefined {
  for (const candidate of localeLookupCandidates(locale)) {
    const match = overlays.find(
      (overlay) => overlay.locale.toLowerCase() === candidate.toLowerCase(),
    );
    if (match) return match;
  }
  return undefined;
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
}): Promise<{
  value: unknown;
  overlays: readonly LocaleOverlayFile[];
  issues: LocaleOverlayFileIssue[];
}> {
  const overlays = await findLocaleOverlays(args.root, args.relativePath);
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
  const compiled = await compileLocaleOverlays({
    root: worldDir,
    relativePath: "world.yaml",
    base,
    baseLocale,
  });
  return {
    raw: compiled.value,
    base,
    overlays: compiled.overlays,
    issues: compiled.issues,
  };
}
