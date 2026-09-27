/** Canonical projections from one registry entry to public plugin DTOs. */

import {
  getPluginTrustInfo,
  pluginDeclarations,
  resolvePluginDeclarations,
  resolvePluginRuntimeManifest,
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
  return [
    ...resolvePluginDeclarations(
      manifests.map((manifest) => ({
        manifest: { ...manifest, pluginId },
        promptTemplate: "",
        rawFrontmatter: {},
      })),
    ).userSettings,
  ];
}

export function buildPluginSummary(entry: PluginRegistryEntry): PluginSummary {
  const manifests = pluginManifestRecords(entry).map(
    ({ manifest }) => manifest,
  );
  const declarations = pluginDeclarations(entry).map(
    ({ manifest }) => manifest,
  );
  const runtimes = manifests.map(runtimeSummary);
  const source = getPluginTrustInfo(entry.id, entry.source).source;
  const relations = mergeRelations(declarations, entry.summary.relations);
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
    runtimeCount: runtimes.length,
    ...((entry.packageManifest?.manifest ?? manifests[0])?.version
      ? { version: (entry.packageManifest?.manifest ?? manifests[0])!.version }
      : {}),
    capabilities: uniqueSorted(
      declarations.flatMap((manifest) => manifest.capabilities ?? []),
    ),
    tags: uniqueSorted([
      ...(entry.summary.tags ?? []),
      ...declarations.flatMap((manifest) => manifest.tags ?? []),
    ]),
    ...(relations ? { relations } : {}),
    runtimes,
    tools,
    userSettings: mergePluginUserSettings(entry.id, declarations),
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
    runtimeContract(resolvePluginRuntimeManifest(entry, manifest)),
  );
  const declarations = pluginDeclarations(entry);
  const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
  const uiDeclarations = (slot: "right" | "message" | "left") =>
    declarations.flatMap(({ manifest }) =>
      (manifest.ui?.[slot] ?? []).map((path) => ({
        ...(runtimeIds.has(manifest.name) ? { runtimeId: manifest.name } : {}),
        path,
      })),
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
      right: uiDeclarations("right"),
      message: uiDeclarations("message"),
      left: uiDeclarations("left"),
    },
    runtimes,
  };
}
