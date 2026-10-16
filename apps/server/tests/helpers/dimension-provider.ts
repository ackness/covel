import path from "node:path";
import {
  discoverPlugins,
  loadPluginDefinition,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";

/**
 * Authored-dimension fixtures must include an actual active authority. Route
 * tests pass `builtin`, the trust the bundled package has at startup.
 */
export async function registerDimensionProvider(
  registry: PluginRegistry,
  source?: PluginRegistryEntry["source"],
): Promise<void> {
  const discovery = (
    await discoverPlugins(
      path.resolve(import.meta.dirname, "../../../../plugins"),
    )
  ).find((item) => item.id === "world-init")!;
  const { manifests, packageManifest } = await loadPluginDefinition(discovery);
  registry.register({
    id: discovery.id,
    rootPath: discovery.rootPath,
    summary: {
      id: discovery.id,
      name: discovery.id,
      description: "",
      kind: "core",
      runtimeCount: manifests.length,
    },
    manifests,
    packageManifest,
    loadedRuntimes: new Map(),
    status: "registered",
    ...(source ? { source } : {}),
  });
}
