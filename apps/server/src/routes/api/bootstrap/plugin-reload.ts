import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistry,
  loadPluginDefinition,
  loadPluginEntryDefinition,
  loadPluginSummary,
  pluginDeclarations,
  type PluginDiscoveryResult,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { assertHostVersionInRange } from "../../../lib/app-version.js";

/** Re-scan only the requested package; malformed siblings cannot break reload. */
export async function preparePluginReload(
  previous: PluginDiscoveryResult,
  entries: readonly PluginRegistryEntry[],
) {
  const runtimes = path.join(previous.rootPath, "runtimes");
  const runtimeDirs = await fs
    .readdir(runtimes, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  const pluginMdPaths: string[] = [];
  if (runtimeDirs) {
    for (const entry of runtimeDirs) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(runtimes, entry.name);
      const legacy = await fs
        .stat(path.join(directory, "PLUGIN.md"))
        .catch(() => undefined);
      if (legacy) throw new Error("Runtime manifests must be named RUNTIME.md");
      const manifest = path.join(directory, "RUNTIME.md");
      if ((await fs.stat(manifest).catch(() => undefined))?.isFile())
        pluginMdPaths.push(manifest);
    }
  } else pluginMdPaths.push(path.join(previous.rootPath, "PLUGIN.md"));
  // Carry package identity forward, not diagnostics from the previous scan.
  const discovery: PluginDiscoveryResult = {
    id: previous.id,
    rootPath: previous.rootPath,
    ...(previous.source ? { source: previous.source } : {}),
    isMultiRuntime: runtimeDirs !== undefined,
    pluginMdPaths: pluginMdPaths.sort(),
  };
  const definition = await loadPluginDefinition(discovery);
  assertHostVersionInRange(
    `Plugin ${discovery.id}`,
    definition.packageManifest.plugin.covel,
  );
  const summary = await loadPluginSummary(discovery, undefined, definition);
  const entry: PluginRegistryEntry = {
    id: discovery.id,
    summary,
    rootPath: discovery.rootPath,
    runtimeManifestPaths: Object.fromEntries(
      definition.manifests.map((parsed) => [
        parsed.manifest.name,
        parsed.sourcePath!,
      ]),
    ),

    packageManifest: definition.packageManifest,
    manifests: definition.manifests,
    messages: definition.messages,
    languages: definition.languages,
    loadedRuntimes: new Map(),
    status: "registered",
    ...(discovery.source ? { source: discovery.source } : {}),
  };
  // Validate cross-package schema conflicts before touching the live registry.
  const validation = createPluginRegistry();
  for (const current of entries)
    if (current.id !== discovery.id) validation.register(current);
  validation.register(entry);
  const entryDefinition = await loadPluginEntryDefinition(
    discovery,
    pluginDeclarations(definition),
  );
  return { discovery, definition, entry, entryDefinition };
}
