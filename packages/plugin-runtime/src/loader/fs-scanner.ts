import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest } from "./manifest-validator.js";
import type { ScannedPlugin } from "../types.js";

/**
 * Scan a directory for plugin subdirectories.
 * Each subdirectory must contain a valid `plugin.json`.
 *
 * Returns successfully scanned plugins; logs warnings for invalid ones.
 */
export async function scanPluginDirectory(
  baseDir: string
): Promise<ScannedPlugin[]> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const results: ScannedPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    const pluginDir = join(baseDir, entry.name);
    const manifestPath = join(pluginDir, "plugin.json");

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      // No plugin.json — skip
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[plugin-scanner] Invalid JSON in ${manifestPath}, skipping.`
      );
      continue;
    }

    const validation = validateManifest(parsed);
    if (!validation.ok) {
      console.warn(
        `[plugin-scanner] Invalid manifest in ${manifestPath}:\n` +
          validation.errors.map((e) => `  - ${e}`).join("\n")
      );
      continue;
    }

    results.push({ dir: pluginDir, manifest: validation.manifest });
  }

  return results;
}
