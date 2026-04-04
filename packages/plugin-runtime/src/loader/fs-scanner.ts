import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest } from "./manifest-validator.js";
import type { ScannedPlugin } from "../types.js";

/** A plugin that failed manifest validation during scanning. */
export interface PluginScanError {
  /** Directory name (e.g. "core-init-wizard"). */
  dirName: string;
  /** Human-readable error messages. */
  errors: string[];
}

export interface ScanResult {
  plugins: ScannedPlugin[];
  scanErrors: PluginScanError[];
}

/**
 * Scan a directory for plugin subdirectories.
 * Each subdirectory must contain a valid `plugin.json`.
 *
 * Returns successfully scanned plugins and a list of scan errors for invalid ones.
 */
export async function scanPluginDirectory(
  baseDir: string
): Promise<ScanResult> {
  const entries = await readdir(baseDir, { withFileTypes: true });
  const plugins: ScannedPlugin[] = [];
  const scanErrors: PluginScanError[] = [];

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
      const msg = `Invalid JSON in plugin.json`;
      console.warn(`[plugin-scanner] ${msg} (${manifestPath}), skipping.`);
      scanErrors.push({ dirName: entry.name, errors: [msg] });
      continue;
    }

    const validation = validateManifest(parsed);
    if (!validation.ok) {
      console.warn(
        `[plugin-scanner] Invalid manifest in ${manifestPath}:\n` +
          validation.errors.map((e) => `  - ${e}`).join("\n")
      );
      scanErrors.push({ dirName: entry.name, errors: validation.errors });
      continue;
    }

    plugins.push({ dir: pluginDir, manifest: validation.manifest });
  }

  return { plugins, scanErrors };
}
