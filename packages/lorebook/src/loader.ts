/**
 * YAML loader for world-level lorebook files.
 *
 * Looks for files under `<worldDir>/lorebook/*.yaml` (and `.yml`). Each file
 * is parsed as a {@link LorebookFile}: an object with an `entries` array.
 *
 * Empty or comment-only files are treated as "no entries" rather than errors,
 * so world authors can leave stub files in place while iterating. A file that
 * parses to something other than an object (e.g. a top-level list) is a hard
 * error — we want schema drift to surface loudly.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  lorebookFileSchema,
  normalizeEntry,
  type LorebookEntry,
  type LorebookSource,
} from "./types.js";

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * List the YAML files inside a directory, sorted alphabetically. Sorting
 * is important because we want the merge order to be deterministic across
 * file systems — some platforms return readdir results unsorted.
 */
async function listYamlFiles(dir: string): Promise<string[]> {
  const dirents = await readdir(dir);
  const yamlFiles = dirents.filter(name =>
    YAML_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );
  yamlFiles.sort();
  return yamlFiles.map(name => path.join(dir, name));
}

export interface LoadLorebookOptions {
  /** Tag the normalized entries with this source. */
  readonly source: LorebookSource;
  /** When `source === 'plugin'`, the plugin id to stamp on each entry. */
  readonly pluginId?: string;
}

/**
 * Load all YAML files from a directory and return the normalized entries.
 * Returns an empty array if the directory does not exist — a world without
 * lorebook content is perfectly valid.
 */
export async function loadLorebookFromDir(
  dir: string,
  options: LoadLorebookOptions,
): Promise<LorebookEntry[]> {
  if (!(await pathExists(dir))) {
    return [];
  }

  const files = await listYamlFiles(dir);
  const out: LorebookEntry[] = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = parseYaml(raw);

    // Empty file or file containing only comments / whitespace — treat
    // as zero entries, not an error. Any other non-object top-level value
    // is a schema violation.
    if (parsed === null || parsed === undefined) {
      continue;
    }

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `[lorebook] ${file}: top-level YAML must be an object with an 'entries' array`,
      );
    }

    const validated = lorebookFileSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(
        `[lorebook] ${file}: schema validation failed\n${issues}`,
      );
    }

    for (const entry of validated.data.entries) {
      out.push(
        normalizeEntry(entry, {
          source: options.source,
          pluginId: options.pluginId,
        }),
      );
    }
  }

  return out;
}

/**
 * Convenience wrapper that resolves `<worldDir>/lorebook` and loads it.
 * Returns `[]` when the world has no lorebook directory.
 */
export async function loadWorldLorebook(
  worldDir: string,
): Promise<LorebookEntry[]> {
  const lorebookDir = path.join(worldDir, "lorebook");
  return loadLorebookFromDir(lorebookDir, { source: "world" });
}
