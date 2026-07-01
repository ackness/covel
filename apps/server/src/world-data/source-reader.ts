import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const MAX_STRUCTURED_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;

/**
 * Resolve a source file with locale awareness, mirroring the WORLD.md /
 * dimension convention: try `<name>.<lang>.<ext>` (e.g. `main-cast.en.json`)
 * before the declared `<name>.<ext>`, where `lang` is the session locale's
 * primary subtag (`en-US` → `en`). Lets a world ship a per-locale variant of
 * any worldData source (character cast, rules/lorebook, …) that the importer
 * picks for the session's locale, falling back to the authored default. Returns
 * the resolved absolute path, or `null` when neither exists / escapes root.
 */
async function resolveSourcePath(
  source: OrderedWorldDataSource,
  locale?: string,
): Promise<string | null> {
  const root = source.pathOrigin.descriptorRoot;
  const declared = source.descriptor.path;
  const lang = locale?.split("-")[0];
  if (lang) {
    const parsed = path.parse(declared);
    const variant = path.join(
      parsed.dir,
      `${parsed.name}.${lang}${parsed.ext}`,
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

export async function readWorldDataSource(
  source: OrderedWorldDataSource,
  locale?: string,
): Promise<{
  value?: unknown;
  path?: string;
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const resolved = await resolveSourcePath(source, locale);
  if (!resolved) {
    return {
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: source.descriptor.path,
          message: `source path is invalid or escapes descriptor root: ${source.descriptor.path}`,
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
          message: "source path must be a regular file",
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
          message: `source file exceeds ${limit} bytes`,
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
    const value =
      source.descriptor.kind === "json" ? JSON.parse(text) : parseYaml(text);
    if (!isJsonValue(value)) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: source.descriptor.path,
        message: "source did not parse to a JSON value",
      });
    }
    return { value, path: resolved, diagnostics };
  } catch (err) {
    return {
      path: resolved,
      diagnostics: [
        {
          level: "error",
          sourceId: source.id,
          path: source.descriptor.path,
          message: `failed to parse source: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}
