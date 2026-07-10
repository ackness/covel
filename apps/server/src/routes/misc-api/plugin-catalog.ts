import { getPluginTrustInfo, type PluginRegistry } from "@covel/plugin-loader";
import { loadLivePluginMaps } from "./live-plugin-maps.js";
import { normalizeRuntimeTrigger } from "./shared.js";

export async function buildPackagesResponse(registry: PluginRegistry): Promise<{
  packages: Array<Record<string, unknown>>;
  loadErrors: Array<{ pluginId: string; errors: string[] }>;
}> {
  const all = registry.getAll();
  const { summaryMap, manifestMap } = await loadLivePluginMaps();
  const packages: Array<Record<string, unknown>> = [];
  const loadErrors: Array<{ pluginId: string; errors: string[] }> = [];

  for (const [, entry] of all) {
    if (entry.status === "error" && entry.error) {
      loadErrors.push({ pluginId: entry.id, errors: [entry.error] });
      continue;
    }

    const liveManifests =
      manifestMap.get(entry.id) ??
      entry.manifests ??
      (entry.manifest ? [entry.manifest] : []);
    const liveSummary = summaryMap.get(entry.id) ?? entry.summary;
    const runtimeSummaryTags = [
      ...new Set(liveManifests.flatMap((m) => [...(m.manifest.tags ?? [])])),
    ].sort((a, b) => a.localeCompare(b));
    const summaryTags =
      liveSummary.tags && liveSummary.tags.length > 0
        ? liveSummary.tags
        : entry.summary.tags && entry.summary.tags.length > 0
          ? entry.summary.tags
          : runtimeSummaryTags;
    const summaryRelations =
      liveSummary.relations ??
      entry.summary.relations ??
      liveManifests[0]?.manifest.relations;

    const runtimes = liveManifests.map((m) => ({
      id: m.manifest.name,
      kind: m.manifest.runtimeType ?? "agent",
      priority: m.manifest.priority ?? 500,
      trigger: normalizeRuntimeTrigger(m.manifest.trigger),
      ...(m.manifest.model ? { model: m.manifest.model } : {}),
      ...(m.manifest.outputKind ? { outputKind: m.manifest.outputKind } : {}),
      ...(m.manifest.capabilities && m.manifest.capabilities.length > 0
        ? { capabilities: [...m.manifest.capabilities] }
        : {}),
      ...(m.manifest.tags && m.manifest.tags.length > 0
        ? { tags: [...m.manifest.tags] }
        : {}),
      ...(m.manifest.relations ? { relations: m.manifest.relations } : {}),
    }));

    const capabilities = [
      ...new Set(
        liveManifests.flatMap((m) => [...(m.manifest.capabilities ?? [])]),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const tags = [...new Set([...summaryTags, ...runtimeSummaryTags])].sort(
      (a, b) => a.localeCompare(b),
    );

    const tools = liveManifests.flatMap((m) => [
      ...(m.manifest.tools?.builtin ?? []).map((t) => ({
        id: t,
        kind: "builtin",
      })),
      ...(m.manifest.tools?.plugin ?? []).map((t) => ({
        id: t,
        kind: "local",
      })),
      ...(m.manifest.tools?.local ?? []).map((t) => {
        const basename =
          t
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? t;
        return { id: basename, kind: "local" };
      }),
    ]);

    // Aggregate userSettings across every runtime of this plugin so the
    // frontend Settings UI can render them under "Plugins > <pluginId>".
    const userSettings = liveManifests.flatMap((m) =>
      (m.manifest.userSettings ?? []).map((spec) => ({ ...spec })),
    );

    packages.push({
      name: entry.id,
      // Serve raw I18nText (the frontend resolves to the UI locale), matching
      // /api/plugins and /api/session/plugins. Prefer the dedicated friendly
      // `displayName`; fall back to summary `name` (an I18nText for multi-runtime
      // packages, else the id). Never collapse to a single locale here.
      displayName: liveSummary.displayName ?? liveSummary.name,
      description: liveSummary.description,
      pluginType: liveSummary.pluginType,
      source: getPluginTrustInfo(entry.id, entry.source).source,
      enabled: true,
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(summaryRelations ? { relations: summaryRelations } : {}),
      runtimes,
      tools,
      ...(userSettings.length > 0 ? { userSettings } : {}),
    });
  }

  return { packages, loadErrors };
}
