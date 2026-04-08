import { readdir, readFile, access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PluginManifest, RuntimeManifest, LoadedPlugin, LoadedRuntime } from "./types.js";
import { randomUUID } from "node:crypto";

export interface ScanResult {
  plugin: LoadedPlugin;
  errors: string[];
}

/**
 * Scan a single plugin directory following V1 structure:
 *   plugin.json
 *   PLUGIN.md
 *   runtimes/<runtime-id>/runtime.json
 */
export async function scanPlugin(pluginDir: string): Promise<ScanResult> {
  const errors: string[] = [];
  const dir = resolve(pluginDir);

  // Read plugin.json
  const manifestPath = join(dir, "plugin.json");
  let manifest: PluginManifest;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as PluginManifest;
  } catch (err) {
    return {
      plugin: null as unknown as LoadedPlugin,
      errors: [`Failed to read plugin.json: ${err instanceof Error ? err.message : err}`],
    };
  }

  // Validate schemaVersion
  if (manifest.schemaVersion !== "covel.plugin/v1") {
    errors.push(`Unsupported schemaVersion: "${manifest.schemaVersion}", expected "covel.plugin/v1".`);
  }

  // Check for PLUGIN.md
  const pluginPromptPath = join(dir, "PLUGIN.md");
  let hasPluginPrompt = false;
  try {
    await access(pluginPromptPath);
    hasPluginPrompt = true;
  } catch { /* no PLUGIN.md */ }

  // Scan runtimes
  const runtimes = new Map<string, LoadedRuntime>();
  const runtimesDir = join(dir, "runtimes");

  for (const runtimeId of manifest.runtimeIds ?? []) {
    const rtDir = join(runtimesDir, runtimeId);
    const rtManifestPath = join(rtDir, "runtime.json");

    try {
      const rtRaw = await readFile(rtManifestPath, "utf-8");
      const rtManifest = JSON.parse(rtRaw) as RuntimeManifest;

      // Resolve file paths
      const instructionsPath = rtManifest.instructionsRef
        ? join(rtDir, rtManifest.instructionsRef)
        : undefined;
      const outputSchemaPath = rtManifest.outputSchemaRef
        ? join(rtDir, rtManifest.outputSchemaRef)
        : undefined;
      const llmConfigPath = rtManifest.llmConfigRef
        ? join(rtDir, rtManifest.llmConfigRef)
        : undefined;

      // Scan tool files
      const toolFiles = await listFiles(join(rtDir, "tools"));
      // Scan script files
      const scriptFiles = await listFiles(join(rtDir, "scripts"));
      // Scan reference files
      const referenceFiles = await listFiles(join(rtDir, "references"));

      runtimes.set(runtimeId, {
        manifest: rtManifest,
        dir: rtDir,
        pluginId: manifest.id,
        instructionsPath,
        pluginPromptPath: hasPluginPrompt ? pluginPromptPath : undefined,
        outputSchemaPath,
        llmConfigPath,
        toolFiles,
        scriptFiles,
        referenceFiles,
      });
    } catch (err) {
      errors.push(`Runtime "${runtimeId}": failed to load — ${err instanceof Error ? err.message : err}`);
    }
  }

  const generationId = randomUUID();

  return {
    plugin: {
      manifest,
      dir,
      runtimes,
      generationId,
    },
    errors,
  };
}

/**
 * Scan all plugin directories under a base directory.
 */
export async function scanAllPlugins(baseDir: string): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  const resolvedBase = resolve(baseDir);

  let entries: string[];
  try {
    entries = await readdir(resolvedBase);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const entryPath = join(resolvedBase, entry);
    const info = await stat(entryPath).catch(() => null);
    if (!info?.isDirectory()) continue;

    // Check if plugin.json exists
    try {
      await access(join(entryPath, "plugin.json"));
    } catch {
      continue;
    }

    const result = await scanPlugin(entryPath);
    results.push(result);
  }

  return results;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((e) => !e.startsWith(".") && !e.startsWith("__"))
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}
