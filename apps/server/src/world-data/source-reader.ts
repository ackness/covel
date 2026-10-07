import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LOCALE,
  applyLocaleOverlay,
  localeLookupCandidates,
} from "@covel/shared";
import { parse as parseYaml } from "yaml";
import {
  findLocaleOverlays,
  pickLocaleOverlay,
  type LocaleOverlayFile,
} from "./locale-overlays.js";
import { explainUnresolvedPath, resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const MAX_STRUCTURED_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;

/**
 * Resolve a prose or media source with locale awareness, mirroring WORLD.md:
 * try the exact canonical locale, then a compatible primary-language short
 * key, before the declared `<name>.<ext>`. Prose has no ids to merge on, so a
 * locale variant replaces the whole file. Structured sources use overlays
 * instead (see `readWorldDataSource`).
 */
async function resolveSourcePath(
  source: OrderedWorldDataSource,
  locale?: string,
): Promise<string | null> {
  const root = source.pathOrigin.descriptorRoot;
  const declared = source.descriptor.path;
  for (const candidateLocale of localeLookupCandidates(locale)) {
    const parsed = path.parse(declared);
    const variant = path.join(
      parsed.dir,
      `${parsed.name}.${candidateLocale}${parsed.ext}`,
    );
    // resolveContainedPath returns null when the variant doesn't exist, so a
    // hit means the file is present, contained, and not a symlink.
    const resolvedVariant = await resolveContainedPath(root, variant, {
      rejectSymlinks: true,
    });
    if (resolvedVariant) return resolvedVariant;
  }
  return resolveContainedPath(root, declared, { rejectSymlinks: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

export interface ReadWorldDataSourceOptions {
  /**
   * How `<name>.<locale>.<ext>` files beside a structured source are used.
   * Default: the overlay of `locale` replaces the main text, giving one
   * language (what a session imports). `compile`: every overlay becomes
   * locale maps, with `baseLocale` naming the main file's language (what the
   * world catalog shows).
   */
  readonly overlays?: {
    readonly mode: "compile";
    readonly baseLocale?: string;
  };
}

function isStructured(source: OrderedWorldDataSource): boolean {
  return source.descriptor.kind === "json" || source.descriptor.kind === "yaml";
}

function parseSource(source: OrderedWorldDataSource, text: string): unknown {
  return source.descriptor.kind === "json" ? JSON.parse(text) : parseYaml(text);
}

export async function readWorldDataSource(
  source: OrderedWorldDataSource,
  locale?: string,
  options: ReadWorldDataSourceOptions = {},
): Promise<{
  value?: unknown;
  path?: string;
  /** Overlay files that were merged into `value`. */
  overlayPaths?: readonly string[];
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const root = source.pathOrigin.descriptorRoot;
  // A structured source is read from its main file and merged with overlays.
  // Without a main file, a locale file still stands in for it.
  const mainPath = isStructured(source)
    ? await resolveContainedPath(root, source.descriptor.path, {
        rejectSymlinks: true,
      })
    : null;
  const resolved = mainPath ?? (await resolveSourcePath(source, locale));
  if (!resolved) {
    const declared = source.descriptor.path;
    const reason = await explainUnresolvedPath(root, declared);
    const what = source.descriptor.kind === "media" ? "directory" : "file";
    return {
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: declared,
          ...(reason === "missing"
            ? {
                message: `source "${source.id}" names a ${what} that does not exist: ${declared}`,
                hint: `Create ${declared}, or correct \`path\` of the source. A path is relative to the world directory.`,
              }
            : reason === "symlink"
              ? {
                  message: `source "${source.id}" names a symbolic link, which is not read: ${declared}`,
                  hint: `Put the ${what} itself at ${declared}.`,
                }
              : {
                  message: `source "${source.id}" names a path outside the world directory: ${declared}`,
                  hint: "Use a path inside the world directory, without `..` and without a leading `/`.",
                }),
        },
      ],
    };
  }

  if (source.descriptor.kind === "media") {
    return { path: resolved, diagnostics };
  }

  const limit =
    source.descriptor.kind === "markdown" || source.descriptor.kind === "text"
      ? MAX_TEXT_BYTES
      : MAX_STRUCTURED_BYTES;
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    return {
      path: resolved,
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: source.descriptor.path,
          message: `source "${source.id}" must name a file; ${source.descriptor.path} is not one`,
          hint: "Name one file in `path`. A directory of pictures or audio is a `kind: media` source.",
        },
      ],
    };
  }

  if (fileStat.size > limit) {
    return {
      path: resolved,
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: source.descriptor.path,
          message: `source "${source.id}": ${source.descriptor.path} is ${fileStat.size} bytes; a ${source.descriptor.kind} source is read up to ${limit} bytes`,
          hint: "Split the content into several files, each with its own source.",
        },
      ],
    };
  }

  try {
    const text = await readFile(resolved, "utf-8");
    if (
      source.descriptor.kind === "markdown" ||
      source.descriptor.kind === "text"
    ) {
      return { value: text, path: resolved, diagnostics };
    }
    let value = parseSource(source, text);
    const overlayPaths: string[] = [];
    if (mainPath) {
      const found = await findLocaleOverlays(root, source.descriptor.path);
      const picked: readonly LocaleOverlayFile[] = options.overlays
        ? found
        : [pickLocaleOverlay(found, locale)].filter(
            (overlay): overlay is LocaleOverlayFile => overlay !== undefined,
          );
      for (const overlay of picked) {
        const overlayStat = await stat(overlay.path);
        if (!overlayStat.isFile() || overlayStat.size > limit) {
          diagnostics.push({
            level: "error",
            sourceId: source.id,
            path: overlay.file,
            message: `locale file must be a regular file of at most ${limit} bytes`,
          });
          continue;
        }
        const merged = applyLocaleOverlay(
          value,
          parseSource(source, await readFile(overlay.path, "utf-8")),
          {
            mode: options.overlays ? "compile" : "resolve",
            locale: overlay.locale,
            baseLocale: options.overlays?.baseLocale ?? DEFAULT_LOCALE,
            arrayKey: [
              source.descriptor.key ?? "id",
              "id",
              ...(source.descriptor.localeArrayKeys ?? []),
            ],
          },
        );
        value = merged.value;
        overlayPaths.push(overlay.path);
        // An ignored entry leaves the main text in place: a warning, so one
        // stale translation does not block a session.
        for (const issue of merged.issues)
          diagnostics.push({
            level: "warning",
            sourceId: source.id,
            path: overlay.file,
            pointer: issue.path,
            localeOverlay: true,
            message: `${overlay.file}: ${issue.path} ${issue.message}`,
          });
      }
    }
    if (!isJsonValue(value)) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: source.descriptor.path,
        message: "source did not parse to a JSON value",
      });
    }
    return {
      value,
      path: resolved,
      ...(overlayPaths.length > 0 ? { overlayPaths } : {}),
      diagnostics,
    };
  } catch (err) {
    return {
      path: resolved,
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: source.descriptor.path,
          message: `source "${source.id}": ${source.descriptor.path} cannot be read as ${source.descriptor.kind}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}
