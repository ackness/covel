/** Canonical projections from one registry entry to public plugin DTOs. */

import {
  getPluginTrustInfo,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { deriveEffects } from "@covel/runtime";
import {
  effectiveTurnCompletion,
  getRuntimeSpec,
  type PluginDetail,
  type PluginRuntimeSummary,
  type PluginSummary,
  type PluginUserSettingSpec,
  type RuntimeManifest,
  type RuntimePluginContract,
} from "@covel/shared";
import { pluginManifestRecords } from "../routes/misc-api/registry-projection.js";

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function runtimeSummary(manifest: RuntimeManifest): PluginRuntimeSummary {
  const stage = getRuntimeSpec(manifest).stage;
  return {
    id: manifest.name,
    runtimeType: manifest.runtimeType ?? "agent",
    ...(stage !== undefined ? { stage } : {}),
    trigger: {
      type: manifest.trigger?.type ?? "auto",
      ...(manifest.trigger?.interval !== undefined
        ? { interval: manifest.trigger.interval }
        : {}),
      ...(manifest.trigger?.cooldownTurns !== undefined
        ? { cooldownTurns: manifest.trigger.cooldownTurns }
        : {}),
      ...(manifest.trigger?.maxTriggerCount !== undefined
        ? { maxTriggerCount: manifest.trigger.maxTriggerCount }
        : {}),
      ...(manifest.trigger?.startTurn !== undefined
        ? { startTurn: manifest.trigger.startTurn }
        : {}),
      ...(manifest.trigger?.topic !== undefined
        ? { topic: manifest.trigger.topic }
        : {}),
    },
    execution: manifest.execution ?? "sync",
    turnCompletion: effectiveTurnCompletion(manifest),
    ...(manifest.model ? { model: manifest.model } : {}),
    outputKind: manifest.outputKind ?? "plugin",
    capabilities: [...(manifest.capabilities ?? [])],
    tags: [...(manifest.tags ?? [])],
    ...(manifest.relations ? { relations: manifest.relations } : {}),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : item,
  );
}

function mergeRelations(
  manifests: readonly RuntimeManifest[],
  summaryRelations?: PluginSummary["relations"],
): PluginSummary["relations"] | undefined {
  const sources = [
    ...(summaryRelations ? [summaryRelations] : []),
    ...manifests.flatMap((manifest) =>
      manifest.relations ? [manifest.relations] : [],
    ),
  ];
  const provides = uniqueSorted(
    sources.flatMap((source) => source.provides ?? []),
  );
  const requires = uniqueSorted(
    sources.flatMap((source) => source.requires ?? []),
  );
  const recommends = uniqueSorted(
    sources.flatMap((source) => source.recommends ?? []),
  );
  const conflicts = uniqueSorted(
    sources.flatMap((source) => source.conflicts ?? []),
  );
  if (
    provides.length === 0 &&
    requires.length === 0 &&
    recommends.length === 0 &&
    conflicts.length === 0
  ) {
    return undefined;
  }
  return {
    ...(provides.length > 0 ? { provides } : {}),
    ...(requires.length > 0 ? { requires } : {}),
    ...(recommends.length > 0 ? { recommends } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

/** Merge runtime declarations that share one plugin-scoped setting key. */
export function mergePluginUserSettings(
  pluginId: string,
  manifests: readonly RuntimeManifest[],
): PluginUserSettingSpec[] {
  const merged = new Map<
    string,
    { spec: PluginUserSettingSpec; runtimeId: string }
  >();
  for (const manifest of manifests) {
    for (const spec of manifest.userSettings ?? []) {
      const existing = merged.get(spec.key);
      if (!existing) {
        merged.set(spec.key, { spec: { ...spec }, runtimeId: manifest.name });
        continue;
      }
      if (stableJson(existing.spec) !== stableJson(spec)) {
        console.warn(
          `[plugin-descriptor] plugin.${pluginId}.${spec.key} differs between ` +
            `"${existing.runtimeId}" and "${manifest.name}"; keeping "${existing.runtimeId}"`,
        );
      }
    }
  }
  return [...merged.values()].map(({ spec }) => spec);
}

export function buildPluginSummary(entry: PluginRegistryEntry): PluginSummary {
  const manifests = pluginManifestRecords(entry).map(
    ({ manifest }) => manifest,
  );
  const runtimes = manifests.map(runtimeSummary);
  const source = getPluginTrustInfo(entry.id, entry.source).source;
  const relations = mergeRelations(manifests, entry.summary.relations);
  const tools = manifests.flatMap((manifest) => [
    ...(manifest.tools?.builtin ?? []).map((id) => ({
      id,
      kind: "builtin" as const,
      runtimeId: manifest.name,
    })),
    ...(manifest.tools?.plugin ?? []).map((id) => ({
      id,
      kind: "local" as const,
      runtimeId: manifest.name,
    })),
  ]);

  return {
    id: entry.id,
    displayName: entry.summary.displayName ?? entry.summary.name ?? entry.id,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    source,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    runtimeCount: entry.summary.runtimeCount,
    ...(manifests[0]?.version ? { version: manifests[0].version } : {}),
    capabilities: uniqueSorted(
      runtimes.flatMap((runtime) => runtime.capabilities),
    ),
    tags: uniqueSorted([
      ...(entry.summary.tags ?? []),
      ...runtimes.flatMap((runtime) => runtime.tags),
    ]),
    ...(relations ? { relations } : {}),
    runtimes,
    tools,
    userSettings: mergePluginUserSettings(entry.id, manifests),
  };
}

function runtimeContract(manifest: RuntimeManifest): RuntimePluginContract {
  const summary = runtimeSummary(manifest);
  const effects = deriveEffects(manifest);
  const dataSchemas = Object.keys(manifest.dataSchemas ?? {});
  const injectedNamespaces =
    manifest.input?.inject
      ?.filter((item) => item.kind === "plugin-data")
      .map((item) => item.namespace) ?? [];

  return {
    ...summary,
    name: manifest.name,
    description: manifest.description,
    after: [...getRuntimeSpec(manifest).deps.after],
    needs: [...getRuntimeSpec(manifest).deps.needs],
    tools: {
      builtin: [...(manifest.tools?.builtin ?? [])],
      local: (manifest.tools?.plugin ?? []).map((name) => ({ name })),
    },
    input: {
      inject: [...(manifest.input?.inject ?? [])],
      tools: [...(manifest.input?.tools ?? [])],
    },
    inputs: { ...manifest.inputs },
    effects: {
      reads: [...effects.reads].sort(),
      writes: [...effects.writes].sort(),
      parallelSafe: effects.parallelSafe,
    },
    output: { ...manifest.output },
    dataSchemas,
    writablePluginDataNamespaces: uniqueSorted([
      ...dataSchemas,
      ...injectedNamespaces,
    ]),
    readablePluginDataNamespaces: uniqueSorted(injectedNamespaces),
    ui: {
      right: [...(manifest.ui?.right ?? [])],
      message: [...(manifest.ui?.message ?? [])],
      left: [...(manifest.ui?.left ?? [])],
    },
    userSettings: [...(manifest.userSettings ?? [])],
  };
}

export function buildPluginDetail(entry: PluginRegistryEntry): PluginDetail {
  const summary = buildPluginSummary(entry);
  const runtimes = pluginManifestRecords(entry).map(({ manifest }) =>
    runtimeContract(manifest),
  );
  const dataSchemas = Object.fromEntries(
    Object.entries(entry.dataSchemas ?? {}).map(([namespace, declaration]) => [
      namespace,
      {
        namespace,
        ...(declaration.schemaVersion !== undefined
          ? { schemaVersion: declaration.schemaVersion }
          : {}),
        ...(declaration.acceptsWorldData !== undefined
          ? { acceptsWorldData: declaration.acceptsWorldData }
          : {}),
        schema: declaration.schema,
        ...(declaration.description
          ? { description: declaration.description }
          : {}),
      },
    ]),
  );

  return {
    ...summary,
    dataSchemas,
    worldProjections: Object.fromEntries(
      Object.entries(entry.worldProjections ?? {}).map(
        ([projectionId, projection]) => [
          projectionId,
          { from: projection.from, outputs: projection.outputs },
        ],
      ),
    ),
    declaredPluginDataNamespaces: uniqueSorted([
      ...Object.keys(dataSchemas),
      ...runtimes.flatMap((runtime) => runtime.writablePluginDataNamespaces),
    ]),
    ui: {
      right: runtimes.flatMap((runtime) =>
        runtime.ui.right.map((path) => ({ runtimeId: runtime.id, path })),
      ),
      message: runtimes.flatMap((runtime) =>
        runtime.ui.message.map((path) => ({ runtimeId: runtime.id, path })),
      ),
      left: runtimes.flatMap((runtime) =>
        runtime.ui.left.map((path) => ({ runtimeId: runtime.id, path })),
      ),
    },
    runtimes,
  };
}
