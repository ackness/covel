import path from "node:path";
import {
  pluginRuntimeManifests,
  type ParsedRuntimeMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";

/** Canonical manifest records published by bootstrap into the registry. */
export function pluginManifestRecords(
  entry: PluginRegistryEntry,
): readonly ParsedRuntimeMd[] {
  return pluginRuntimeManifests(entry);
}

/** Resolve a runtime directory without rediscovering or reparsing its plugin. */
export function pluginRuntimeDirectory(
  entry: PluginRegistryEntry,
  runtimeName: string,
): string | undefined {
  const documentPath = pluginRuntimeDocumentPath(entry, runtimeName);
  return documentPath ? path.dirname(documentPath) : undefined;
}

/** Discovered PLUGIN.md or RUNTIME.md path represented by a registry record. */
export function pluginRuntimeDocumentPath(
  entry: PluginRegistryEntry,
  runtimeName: string,
): string | undefined {
  return entry.runtimeManifestPaths?.[runtimeName];
}
