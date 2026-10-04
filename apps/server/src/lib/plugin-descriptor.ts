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
    ...(manifest.outputContract
      ? { outputContract: manifest.outputContract }
      : {}),
    tags: [...(manifest.tags ?? [])],
  };
}

export function buildPluginSummary(
  entry: PluginRegistryEntry,
  isEntryPublished?: (pluginId: string) => boolean,
): PluginSummary {
  const manifests = pluginManifestRecords(entry).map(
    ({ manifest }) => manifest,
  );
  const declarations = pluginDeclarations(entry).map(
    ({ manifest }) => manifest,
  );
  const runtimes = manifests.map(runtimeSummary);
  const source = getPluginTrustInfo(entry.id, entry.source).source;
  const plugin = entry.packageManifest?.plugin;
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
    kind: plugin?.kind ?? "plugin",
    source,
    hostState: isEntryPublished?.(entry.id)
      ? "loaded"
      : entry.status === "error" || entry.error
        ? "error"
        : entry.status === "discovered"
          ? "discovered"
          : "installed",
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.registrationError
      ? { registrationError: { ...entry.registrationError } }
      : {}),
    runtimeCount: runtimes.length,
    ...((entry.packageManifest?.manifest ?? manifests[0])?.version
      ? { version: (entry.packageManifest?.manifest ?? manifests[0])!.version }
      : {}),
    ...(plugin?.author ? { author: plugin.author } : {}),
    ...(plugin?.license ? { license: plugin.license } : {}),
    ...(plugin?.homepage ? { homepage: plugin.homepage } : {}),
    provides: plugin?.provides ?? [],
    requires: plugin?.requires ?? [],
    optional: plugin?.optional ?? [],
    conflicts: plugin?.conflicts ?? [],
    extensions: [
      ...(plugin?.contributes?.extensions ?? []),
      ...(plugin?.contributes?.prompt?.length
        ? [{ point: "prompt.segment@1", id: "static-prompt" }]
        : []),
    ],
    tags: uniqueSorted([
      ...(entry.summary.tags ?? []),
      ...declarations.flatMap((manifest) => manifest.tags ?? []),
    ]),
    runtimes,
    tools,
    userSettings: [...(plugin?.contributes?.settings ?? [])],
    languages: entry.languages ?? { text: ["en"], instructions: ["en"] },
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
      tools: [],
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

export function buildPluginDetail(
  entry: PluginRegistryEntry,
  isEntryPublished?: (pluginId: string) => boolean,
): PluginDetail {
  const summary = buildPluginSummary(entry, isEntryPublished);
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
