import { resolveWorldPluginSelection } from "./world-plugin-selection.js";
import type {
  PluginPack,
  WorldPluginSelectionDiagnostic,
} from "./types/plugin-api.js";
import {
  providedContracts,
  resolveSessionPlugins,
  type SessionPluginCandidate,
} from "./plugin-selection.js";
import type { CollectionProblem } from "./schemas/collection.js";
import { satisfiesHostVersionRange } from "./utils/host-version-range.js";
import type { ExtensionDeclaration } from "./extension-points/index.js";
import type { PluginManifest } from "./types/plugin-manifest.js";

/** What a plugin contributes to resolving a set, read from its manifest. */
export interface CollectionPluginFacts {
  readonly id: string;
  readonly contracts: readonly string[];
  readonly kind?: PluginManifest["kind"];
  readonly provides?: PluginManifest["provides"];
  readonly eventTopics?: readonly string[];
  readonly acceptsWorldData?: readonly string[];
  readonly runtimes?: SessionPluginCandidate["runtimes"];
  readonly dataDeclarations?: NonNullable<
    PluginManifest["contributes"]
  >["data"];
  readonly requires?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly extensions?: readonly ExtensionDeclaration[];
  /** The plugin's `covel` host range, when it declares one. */
  readonly hostRange?: string;
}

/** Static world requests, including only the initial pack's members. */
export interface CollectionWorldFacts {
  readonly id: string;
  readonly requires: readonly string[];
  readonly requiredDataContracts?: readonly string[];
  readonly requested: readonly string[];
  readonly excluded?: readonly string[];
  readonly requests?: readonly {
    pluginId: string;
    path: string;
    packId?: string;
  }[];
  readonly diagnostics?: readonly WorldPluginSelectionDiagnostic[];
}

/**
 * Facts from a loaded root manifest. Its `id` and `provides` are the ones the
 * loader works out: the directory name, and the contracts the runtimes
 * output as well as the written ones.
 */
export function collectionPluginFacts(
  manifest: Pick<
    PluginManifest,
    "id" | "provides" | "requires" | "conflicts" | "covel" | "contributes"
  > &
    Partial<Pick<PluginManifest, "kind">>,
  runtimes?: SessionPluginCandidate["runtimes"],
): CollectionPluginFacts {
  return {
    id: manifest.id,
    runtimes,
    kind: manifest.kind,
    provides: manifest.provides,
    eventTopics: manifest.contributes?.events?.map((event) => event.topic),
    dataDeclarations: manifest.contributes?.data,
    requires: [...(manifest.requires ?? [])],
    conflicts: manifest.conflicts,
    extensions: manifest.contributes?.extensions,
    acceptsWorldData: [
      ...new Set(
        Object.values(manifest.contributes?.data ?? {}).flatMap(
          (data) => data.accepts ?? [],
        ),
      ),
    ],
    contracts: providedContracts({
      provides: manifest.provides ?? [],
      extensions: manifest.contributes?.extensions ?? [],
    }),
    ...(manifest.covel ? { hostRange: manifest.covel } : {}),
  };
}

/** Parse references with the same host catalogue used by preparation. */
export function collectionWorldFacts(
  manifest: Readonly<Record<string, unknown>>,
  packs: readonly PluginPack[],
  directoryName?: string,
): CollectionWorldFacts {
  const resolved = resolveWorldPluginSelection(manifest.plugins, packs);
  return {
    id: typeof manifest.id === "string" ? manifest.id : String(directoryName),
    requires: resolved.selection.requiredContracts,
    requested: [...new Set(resolved.requests.map((ref) => ref.pluginId))],
    excluded: resolved.packs.find((pack) => pack.id === resolved.selectedPackId)
      ?.excluded,
    requests: resolved.requests,
    diagnostics: resolved.diagnostics,
  };
}

/**
 * Static completeness check for a set of worlds and plugins installed
 * together. It reads manifests only; no plugin code runs. The server uses it
 * for install previews and `pnpm validate:collection` uses it in CI, so an
 * author sees the same findings a player would.
 */
export function checkCollection(args: {
  readonly worlds: readonly CollectionWorldFacts[];
  /** Plugins the set installs. */
  readonly plugins: readonly CollectionPluginFacts[];
  /** Plugins the host already has: bundled and installed ones. */
  readonly available: readonly CollectionPluginFacts[];
  readonly hostVersion?: string;
  /** The collection manifest's own `covel` range. */
  readonly collectionRange?: string;
}): CollectionProblem[] {
  const problems: CollectionProblem[] = [];
  // A member being installed replaces the host's earlier manifest facts.
  // Duplicate members still receive their own diagnostic below.
  const everyPlugin = [
    ...new Map(
      [...args.available, ...args.plugins].map((plugin) => [plugin.id, plugin]),
    ).values(),
  ];
  const known = new Set(everyPlugin.map((plugin) => plugin.id));

  const outsideRange = (range: string | undefined) =>
    range !== undefined &&
    args.hostVersion !== undefined &&
    satisfiesHostVersionRange(args.hostVersion, range) === false;
  if (outsideRange(args.collectionRange))
    problems.push({
      level: "error",
      message: `This collection needs Covel ${args.collectionRange}; this host runs ${args.hostVersion}.`,
    });
  for (const plugin of args.plugins)
    if (outsideRange(plugin.hostRange))
      problems.push({
        level: "error",
        packageId: plugin.id,
        message: `Plugin ${plugin.id} needs Covel ${plugin.hostRange}; this host runs ${args.hostVersion}.`,
      });

  for (const plugin of args.plugins) {
    for (const contract of plugin.requires ?? []) {
      if (
        !everyPlugin.some((provider) => provider.contracts.includes(contract))
      )
        problems.push({
          level: "error",
          packageId: plugin.id,
          message: `Plugin ${plugin.id} requires ${contract}, and no installed or included plugin provides it.`,
        });
    }
  }

  const seen = new Set<string>();
  for (const { kind, id } of [
    ...args.plugins.map((plugin) => ({ kind: "plugin", id: plugin.id })),
    ...args.worlds.map((world) => ({ kind: "world", id: world.id })),
  ]) {
    const key = `${kind}:${id}`;
    if (seen.has(key))
      problems.push({
        level: "error",
        packageId: id,
        message: `The ${kind} ${id} is listed more than once.`,
      });
    seen.add(key);
  }

  for (const world of args.worlds) {
    for (const diagnostic of world.diagnostics ?? [])
      problems.push({
        level:
          diagnostic.code === "unknown-pack" ||
          diagnostic.code === "redundant-reference"
            ? "warning"
            : "error",
        packageId: world.id,
        path: diagnostic.path,
        ...(diagnostic.packId ? { packId: diagnostic.packId } : {}),
        message: `World ${world.id}: ${diagnostic.code} at ${diagnostic.path}${diagnostic.reference ? ` (${diagnostic.reference})` : ""}.`,
      });
    for (const contract of world.requires) {
      const providers = [
        ...new Set(
          everyPlugin
            .filter((plugin) => plugin.contracts.includes(contract))
            .map((plugin) => plugin.id),
        ),
      ];
      if (providers.length === 0)
        problems.push({
          level: "warning",
          packageId: world.id,
          message: `World ${world.id} requests ${contract}, and no installed or included plugin provides it; play continues without that feature.`,
        });
      else if (
        providers.length > 1 &&
        !providers.some((id) => world.requested.includes(id))
      )
        problems.push({
          level: "warning",
          packageId: world.id,
          message: `World ${world.id} requires ${contract}, which ${providers.join(", ")} all provide. Add a plugin: reference to the world's plugins, or players must choose.`,
        });
    }
    const dataPlan = resolveSessionPlugins({
      requested: world.requested,
      excluded: world.excluded,
      requiredDataContracts: world.requiredDataContracts,
      plugins: everyPlugin.map((plugin) => ({
        ...plugin,
        kind: plugin.kind ?? "plugin",
        source: "builtin",
        authorized: true,
        provides: plugin.provides ?? [...plugin.contracts],
      })),
    });
    for (const missing of dataPlan.unmetData)
      problems.push({
        level: "warning",
        packageId: world.id,
        message: `World ${world.id}: data contract ${missing.contract} has ${missing.code === "ambiguous-provider" ? "several receivers; players must choose" : missing.code === "excluded" ? "only excluded receivers" : "no eligible receiver"}; play continues without that data.`,
      });
    const requests =
      world.requests ?? world.requested.map((pluginId) => ({ pluginId }));
    for (const request of requests) {
      if (known.has(request.pluginId)) continue;
      problems.push({
        level: "warning",
        packageId: world.id,
        ...("path" in request ? { path: request.path } : {}),
        ...("packId" in request && request.packId
          ? { packId: request.packId }
          : {}),
        message: `World ${world.id} requests plugin ${request.pluginId}, which is neither installed nor included; play continues without that feature.`,
      });
    }
  }
  return problems;
}
