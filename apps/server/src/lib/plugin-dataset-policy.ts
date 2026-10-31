/** Capture registered package declarations without loading executable runtimes. */
import type { PluginRegistryEntry } from "@covel/plugin-loader";
import {
  datasetPolicyResolver,
  type DatasetPolicyResolver,
} from "@covel/runtime";

export const emptyDatasetPolicy: DatasetPolicyResolver = () => undefined;

export function capturePluginDatasetPolicy(
  entries: Iterable<PluginRegistryEntry>,
): DatasetPolicyResolver {
  const packages = [...entries];
  return (
    datasetPolicyResolver(
      packages.map((entry) => ({
        pluginId: entry.id,
        datasets: entry.datasets,
      })),
      Object.fromEntries(
        packages.map((entry) => [
          entry.id,
          entry.packageManifest?.datasetSchemas ?? {},
        ]),
      ),
    ) ?? emptyDatasetPolicy
  );
}
