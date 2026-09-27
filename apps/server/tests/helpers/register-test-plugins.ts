import {
  discoverPluginsMulti,
  loadPluginDefinition,
  loadPluginSummary,
  type PluginRegistry,
} from "@covel/plugin-loader";
import path from "node:path";

/** Register disk fixtures the same way bootstrap publishes its canonical snapshot. */
export async function registerTestPlugins(
  registry: PluginRegistry,
  pluginDirectories: readonly string[],
): Promise<void> {
  const discoveries = await discoverPluginsMulti(pluginDirectories);
  for (const discovery of discoveries) {
    const definition = await loadPluginDefinition(discovery);
    const { packageManifest, manifests } = definition;
    const summary = await loadPluginSummary(discovery, undefined, definition);
    registry.register({
      id: discovery.id,
      summary,
      rootPath: discovery.rootPath,
      runtimeManifestPaths: Object.fromEntries(
        manifests.map((parsed, index) => [
          parsed.manifest.name,
          path.resolve(discovery.pluginMdPaths[index]!),
        ]),
      ),
      packageManifest,
      manifest: manifests[0],
      manifests,
      loadedRuntimes: new Map(),
      status: "registered",
      ...(discovery.source ? { source: discovery.source } : {}),
    });
  }
}
