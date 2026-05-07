import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { resolveContainedPath } from "./safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const MAX_STRUCTURED_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;

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
): Promise<{
  value?: unknown;
  path?: string;
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const resolved = await resolveContainedPath(
    source.pathOrigin.descriptorRoot,
    source.descriptor.path,
    { rejectSymlinks: true },
  );
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
