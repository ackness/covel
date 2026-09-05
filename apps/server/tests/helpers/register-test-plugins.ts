import {
  discoverPluginsMulti,
  loadPluginManifest,
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
    const [summary, manifests] = await Promise.all([
      loadPluginSummary(discovery),
      loadPluginManifest(discovery),
    ]);
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
      manifest: manifests[0],
      manifests,
      loadedRuntimes: new Map(),
      status: "registered",
      ...(discovery.source ? { source: discovery.source } : {}),
    });
  }
}
