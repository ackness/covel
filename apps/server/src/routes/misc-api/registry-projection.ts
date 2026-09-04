import path from "node:path";
import type { ParsedPluginMd, PluginRegistryEntry } from "@covel/plugin-loader";

/** Canonical manifest records published by bootstrap into the registry. */
export function pluginManifestRecords(
  entry: PluginRegistryEntry,
): readonly ParsedPluginMd[] {
  return entry.manifests && entry.manifests.length > 0
    ? entry.manifests
    : entry.manifest
      ? [entry.manifest]
      : [];
}

/** Resolve a runtime directory without rediscovering or reparsing its plugin. */
export function pluginRuntimeDirectory(
  entry: PluginRegistryEntry,
  runtimeName: string,
): string | undefined {
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
  const runtimeDirectory = pluginRuntimeDirectory(entry, runtimeName);
  return runtimeDirectory
    ? path.join(runtimeDirectory, "PLUGIN.md")
    : undefined;
}
