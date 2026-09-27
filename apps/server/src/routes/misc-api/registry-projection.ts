import path from "node:path";
import {
  pluginRuntimeManifests,
  type ParsedPluginMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";

/** Canonical manifest records published by bootstrap into the registry. */
export function pluginManifestRecords(
  entry: PluginRegistryEntry,
): readonly ParsedPluginMd[] {
  return pluginRuntimeManifests(entry);
}

/** Resolve a runtime directory without rediscovering or reparsing its plugin. */
export function pluginRuntimeDirectory(
  entry: PluginRegistryEntry,
  runtimeName: string,
): string | undefined {
  if (entry.packageManifest?.manifest.name === runtimeName)
    return entry.rootPath;
  if (entry.runtimeManifestPaths) {
    const documentPath = entry.runtimeManifestPaths[runtimeName];
    return documentPath ? path.dirname(documentPath) : undefined;
  }
  // Compatibility for manually constructed registry entries without discovery metadata.
  if (!entry.rootPath) return undefined;
  if (runtimeName === entry.id) return entry.rootPath;
  const prefix = `${entry.id}/`;
  const localName = runtimeName.startsWith(prefix)
    ? runtimeName.slice(prefix.length)
    : runtimeName;
  return path.join(entry.rootPath, "runtimes", localName);
}

/** PLUGIN.md path represented by a registry runtime record. */
export function pluginRuntimeDocumentPath(
  entry: PluginRegistryEntry,
  runtimeName: string,
): string | undefined {
  if (entry.runtimeManifestPaths) {
    return entry.runtimeManifestPaths[runtimeName];
  }
  const runtimeDirectory = pluginRuntimeDirectory(entry, runtimeName);
  return runtimeDirectory
    ? path.join(runtimeDirectory, "PLUGIN.md")
    : undefined;
}
