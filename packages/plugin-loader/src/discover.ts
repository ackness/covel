import { fileExists, isDirectory } from "./file-system.js";
/**
 * Plugin discovery — scans the plugins directory for plugin packages.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDiscoveryResult } from "./types.js";
import { runtimeDirectoryDiagnostics } from "./runtime-directory.js";

/**
 * Scan a directory for plugin packages.
 *
 * Rules:
 * - Each subdirectory is a plugin candidate, including a symlink to a
 *   directory (a plugin developed in another checkout). File reads stay
 *   confined to the plugin's resolved root (`assertInsideRoot`).
 * - If subdir has `runtimes/` → multi-runtime plugin
 * - If subdir has `PLUGIN.md` without `runtimes/` → single-runtime plugin
 * - `.disabled` suffix files are skipped
 * - Directories without any PLUGIN.md are skipped
 */
export async function discoverPlugins(
  pluginsDir: string,
): Promise<readonly PluginDiscoveryResult[]> {
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  const results: PluginDiscoveryResult[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rootPath = path.join(pluginsDir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!(await isDirectory(rootPath))) {
        console.warn(
          `[plugin-loader] skipping ${rootPath}: symlink does not resolve to a directory`,
        );
        continue;
      }
    } else if (!entry.isDirectory()) {
      continue;
    }

    const discovery = await discoverPluginAt(rootPath);
    if (discovery) results.push(discovery);
  }

  return results;
}

/** Discover one package without importing its code. Disabled/non-plugin roots are absent. */
export async function discoverPluginAt(
  rootPath: string,
): Promise<PluginDiscoveryResult | undefined> {
  rootPath = path.resolve(rootPath);
  const id = path.basename(rootPath);
  const pluginMdPath = path.join(rootPath, "PLUGIN.md");
  if (await fileExists(path.join(rootPath, "PLUGIN.md.disabled")))
    return undefined;
  const runtimesDir = path.join(rootPath, "runtimes");
  if (!(await isDirectory(runtimesDir))) {
    return (await fileExists(pluginMdPath))
      ? { id, rootPath, isMultiRuntime: false, pluginMdPaths: [pluginMdPath] }
      : undefined;
  }
  const runtimeEntries = await fs.readdir(runtimesDir, { withFileTypes: true });
  const pluginMdPaths: string[] = [];
  const layoutWarnings: string[] = [];
  let layoutError: string | undefined;
  for (const entry of runtimeEntries.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // Match authoring tools: runtime symlinks are not runtime directories.
    if (!entry.isDirectory()) continue;
    const directory = path.join(runtimesDir, entry.name);
    const files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((file) => file.isFile() || file.isSymbolicLink())
      .map((file) => file.name);
    const diagnostic = runtimeDirectoryDiagnostics(directory, files);
    layoutError ??= diagnostic.error;
    if (diagnostic.warning) layoutWarnings.push(diagnostic.warning);
    if (
      files.includes("RUNTIME.md") &&
      (await fileExists(path.join(directory, "RUNTIME.md")))
    )
      pluginMdPaths.push(path.join(directory, "RUNTIME.md"));
  }
  if (!(await fileExists(pluginMdPath)))
    layoutError ??= `${rootPath}: a plugin root PLUGIN.md is required`;
  return {
    id,
    rootPath,
    isMultiRuntime: true,
    pluginMdPaths,
    ...(layoutError ? { layoutError } : {}),
    ...(layoutWarnings.length ? { layoutWarnings } : {}),
  };
}

/**
 * Discover plugins across multiple directories.
 *
 * Semantics:
 *   - Directories are scanned in the order provided (typically bundled first,
 *     then user-provided). The FIRST occurrence of a given plugin id wins —
 *     so bundled plugins cannot be shadowed by a user plugin with the same id.
 *   - Plugins from index 0 are tagged `source: 'builtin'`. Plugins from index >= 1 are tagged
 *     `source: 'community'` so a user-dropped `core-evil` cannot auto-load.
 *   - Collisions are reported via `onCollision` so the caller can warn.
 *   - Missing directories are silently skipped (user dirs may not exist yet).
 */
export async function discoverPluginsMulti(
  pluginsDirs: readonly string[],
  onCollision?: (id: string, kept: string, skipped: string) => void,
): Promise<readonly PluginDiscoveryResult[]> {
  const seen = new Map<string, PluginDiscoveryResult>();
  for (const [i, dir] of pluginsDirs.entries()) {
    if (!(await isDirectory(dir))) continue;
    const results = await discoverPlugins(dir);
    for (const result of results) {
      const existing = seen.get(result.id);
      if (existing) {
        onCollision?.(result.id, existing.rootPath, result.rootPath);
        continue;
      }
      // Tag by load path: index 0 (bundled `plugins/`) → 'builtin', everything
      // else → 'community'. Without an explicit source, getPluginTrustInfo
      // falls through to the community fallback and bootstrap skips importing
      // tools.local for shipped plugins (regression after dropping the core-
      // prefix heuristic in 85a7684).
      seen.set(result.id, {
        ...result,
        source: i === 0 ? "builtin" : "community",
      });
    }
  }
  return Array.from(seen.values());
}
