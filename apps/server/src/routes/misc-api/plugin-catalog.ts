import { getPluginTrustInfo, type PluginRegistry } from "@covel/plugin-loader";
import { getRuntimeSpec } from "@covel/shared";
import type { PluginUserSettingSpec, RuntimeManifest } from "@covel/shared";
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
      ...(getRuntimeSpec(m.manifest).stage !== undefined
        ? { stage: getRuntimeSpec(m.manifest).stage }
        : {}),
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
    ]);

    // Aggregate userSettings across every runtime of this plugin so the
    // frontend Settings UI can render them under "Plugins > <pluginId>".
    const userSettings = mergeUserSettings(entry.id, liveManifests);

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

/**
 * Merge a plugin's `userSettings` across its runtimes.
 *
 * The stored key is `plugin.<pluginId>.<key>` — plugin-scoped — while the
 * declaration lives on a runtime manifest, so two runtimes of one plugin can
 * declare the same key. Identical declarations are the normal case (a shared
 * knob repeated on every runtime that reads it) and dedupe silently. Diverging
 * ones are an authoring bug: both map to one stored value, and which wins
 * depends on manifest load order. Warn and keep the first — the same collision
 * discipline `dataSchemas` / `memoryBlocks` / `events` already apply.
 */
export function mergeUserSettings(
  pluginId: string,
  manifests: ReadonlyArray<{ readonly manifest: RuntimeManifest }>,
): PluginUserSettingSpec[] {
  const merged = new Map<
    string,
    { spec: PluginUserSettingSpec; runtime: string }
  >();
  for (const { manifest } of manifests) {
    for (const spec of manifest.userSettings ?? []) {
      const existing = merged.get(spec.key);
      if (!existing) {
        merged.set(spec.key, { spec: { ...spec }, runtime: manifest.name });
        continue;
      }
      if (stableJson(existing.spec) !== stableJson(spec)) {
        console.warn(
          `[plugin-catalog] ${pluginId}: userSettings key "${spec.key}" is declared ` +
            `differently by "${existing.runtime}" and "${manifest.name}". Both map to ` +
            `plugin.${pluginId}.${spec.key}, so "${existing.runtime}" wins and the other ` +
            `declaration is ignored. Declare the key on one runtime, or make the two identical.`,
        );
      }
    }
  }
  return [...merged.values()].map((e) => e.spec);
}

/** Key-order-independent serialisation, so field ordering is not a difference. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : val,
  );
}
