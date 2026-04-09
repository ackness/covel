/**
 * Plugin discovery — scans the plugins directory for plugin packages.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginDiscoveryResult } from './types.js';

/**
 * Check whether a path is a directory.
 */
async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether a file exists (not a directory).
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Scan a directory for plugin packages.
 *
 * Rules:
 * - Each subdirectory is a plugin candidate
 * - If subdir has `runtimes/` → multi-runtime plugin
 * - If subdir has `PLUGIN.md` without `runtimes/` → single-runtime plugin
 * - `.disabled` suffix files are skipped
 * - Directories without any PLUGIN.md are skipped
 */
export async function discoverPlugins(pluginsDir: string): Promise<readonly PluginDiscoveryResult[]> {
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  const results: PluginDiscoveryResult[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const rootPath = path.join(pluginsDir, entry.name);
    const runtimesDir = path.join(rootPath, 'runtimes');
    const pluginMdPath = path.join(rootPath, 'PLUGIN.md');
    const disabledPath = path.join(rootPath, 'PLUGIN.md.disabled');

    // Skip disabled plugins
    if (await fileExists(disabledPath)) {
      continue;
    }

    // Check for multi-runtime layout
    if (await isDirectory(runtimesDir)) {
      const runtimeEntries = await fs.readdir(runtimesDir, {
        withFileTypes: true,
      });
      const pluginMdPaths: string[] = [];

      for (const rtEntry of runtimeEntries) {
        if (!rtEntry.isDirectory()) {
          continue;
        }
        const rtPluginMd = path.join(
          runtimesDir,
          rtEntry.name,
          'PLUGIN.md',
        );
        if (await fileExists(rtPluginMd)) {
          pluginMdPaths.push(rtPluginMd);
        }
      }

      if (pluginMdPaths.length > 0) {
        results.push({
          id: entry.name,
          rootPath,
          isMultiRuntime: true,
          pluginMdPaths,
        });
        continue;
      }
    }

    // Check for single-runtime layout
    if (await fileExists(pluginMdPath)) {
      results.push({
        id: entry.name,
        rootPath,
        isMultiRuntime: false,
        pluginMdPaths: [pluginMdPath],
      });
    }
  }

  return results;
}
