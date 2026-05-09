import {
  discoverPluginsMulti,
  loadPluginManifest,
  loadPluginSummary,
} from "@covel/plugin-loader";
import { resolvePluginsDirs } from "./shared.js";

export async function loadLivePluginMaps() {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());
  const summaryMap = new Map<
    string,
    Awaited<ReturnType<typeof loadPluginSummary>>
  >();
  const manifestMap = new Map<
    string,
    Awaited<ReturnType<typeof loadPluginManifest>>
  >();

  await Promise.all(
    discoveries.map(async (discovery) => {
      const [summary, manifests] = await Promise.all([
        loadPluginSummary(discovery),
        loadPluginManifest(discovery),
      ]);
      summaryMap.set(discovery.id, summary);
      manifestMap.set(discovery.id, manifests);
    }),
  );

  return { summaryMap, manifestMap };
}
