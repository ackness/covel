import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const DESKTOP_CONFIG_SCHEMA_VERSION = 1 as const;

export const DESKTOP_PROXY_MODES = [
  "direct",
  "system",
  "http",
  "socks",
] as const;

export type DesktopProxyMode = (typeof DESKTOP_PROXY_MODES)[number];

const pathsSchema = z
  .object({
    // Empty strings remain readable for compatibility and resolve to the
    // default data root. Settings writes only persist non-empty absolute paths.
    data_root: z.string().optional(),
  })
  .passthrough();

const networkSchema = z
  .object({
    proxy_mode: z.enum(DESKTOP_PROXY_MODES).optional(),
    // Empty is the canonical representation for modes that need no fixed URL.
    proxy_url: z.string().optional(),
  })
  .passthrough();

const loggingSchema = z
  .object({
    max_size_mb: z.number().int().positive().optional(),
    max_files: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Versioned schema for `~/.covel/config.toml`.
 *
 * Unknown root keys, sections, and keys inside framework-owned sections pass
 * through unchanged so newer versions and operator-authored metadata survive
 * an older binary's focused patch. A missing schema_version is legacy v1.
 */
export const desktopConfigSchema = z
  .object({
    schema_version: z.literal(DESKTOP_CONFIG_SCHEMA_VERSION).default(1),
    paths: pathsSchema.optional(),
    network: networkSchema.optional(),
    logging: loggingSchema.optional(),
  })
  .passthrough();

export type DesktopConfig = z.infer<typeof desktopConfigSchema>;

export function parseDesktopConfig(source: string): DesktopConfig {
  return desktopConfigSchema.parse(parseToml(source));
}

export type DesktopConfigPatch = Readonly<{
  paths?: Readonly<{
    /** null comments out the current assignment, restoring the default. */
    data_root?: string | null;
  }>;
  network?: Readonly<{
    proxy_mode?: DesktopProxyMode;
    proxy_url?: string;
  }>;
  logging?: Readonly<{
    max_size_mb?: number;
    max_files?: number;
  }>;
}>;

type TomlScalar = string | number;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find a TOML inline comment without mistaking # inside a string for one. */
function inlineComment(source: string): string {
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote === "double") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"') quote = "double";
    else if (char === "'") quote = "single";
    else if (char === "#") return source.slice(index).trimEnd();
  }
  return "";
}

function renderScalar(value: TomlScalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function patchSection(
  source: string,
  section: string,
  values: Readonly<Record<string, TomlScalar | null | undefined>>,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const entries = Object.entries(values).filter(
    (entry): entry is [string, TomlScalar | null] => entry[1] !== undefined,
  );
  if (entries.length === 0) return source;
  const lines = source.split(/\r\n|\n/);
  const escapedSection = escapeRegExp(section);
  const headerPattern = new RegExp(`^\\s*\\[${escapedSection}]\\s*(?:#.*)?$`);
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));

  if (headerIndex < 0) {
    const body = entries
      .map(([key, value]) =>
        value === null ? `# ${key} = ""` : `${key} = ${renderScalar(value)}`,
      )
      .join(newline);
    const separator =
      source.length === 0
        ? ""
        : source.endsWith(`${newline}${newline}`)
          ? ""
          : source.endsWith(newline)
            ? newline
            : `${newline}${newline}`;
    return `${source}${separator}[${section}]${newline}${body}${newline}`;
  }

  let sectionEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    // Both ordinary tables (`[section]`) and arrays of tables (`[[items]]`)
    // end the current section. Treating only the former as a boundary would
    // insert a new known key inside an unrelated operator-owned array table.
    if (/^\s*\[\[?[^\]]+]\]?\s*(?:#.*)?$/.test(lines[index]!)) {
      sectionEnd = index;
      break;
    }
  }

  let insertAt = headerIndex + 1;
  for (const [key, value] of entries) {
    const escapedKey = escapeRegExp(key);
    const keyPattern = new RegExp(`^(\\s*)(?:#\\s*)?${escapedKey}\\s*=(.*)$`);
    let existingIndex = -1;
    let match: RegExpMatchArray | null = null;
    for (let index = headerIndex + 1; index < sectionEnd; index += 1) {
      const candidate = lines[index]!.match(keyPattern);
      if (candidate) {
        existingIndex = index;
        match = candidate;
        break;
      }
    }

    if (existingIndex >= 0 && match) {
      const indent = match[1] ?? "";
      if (value === null) {
        const assignment = lines[existingIndex]!.trimStart().replace(
          /^#\s*/,
          "",
        );
        lines[existingIndex] = `${indent}# ${assignment}`;
      } else {
        const comment = inlineComment(match[2] ?? "");
        lines[existingIndex] =
          `${indent}${key} = ${renderScalar(value)}${comment ? ` ${comment}` : ""}`;
      }
      insertAt = Math.max(insertAt, existingIndex + 1);
      continue;
    }

    const rendered =
      value === null ? `# ${key} = ""` : `${key} = ${renderScalar(value)}`;
    lines.splice(insertAt, 0, rendered);
    insertAt += 1;
    sectionEnd += 1;
  }

  return lines.join(newline);
}

/**
 * Strictly parse the current source, apply only known scalar assignments, then
 * parse the result again. No caller can turn a corrupt file into an apparently
 * valid partial config and overwrite the recoverable original.
 */
export function patchDesktopConfigSource(
  source: string,
  patch: DesktopConfigPatch,
): string {
  parseDesktopConfig(source);
  let next = source;
  if (patch.paths) next = patchSection(next, "paths", patch.paths);
  if (patch.network) next = patchSection(next, "network", patch.network);
  if (patch.logging) next = patchSection(next, "logging", patch.logging);
  parseDesktopConfig(next);
  return next;
}
