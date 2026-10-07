import { providedContracts } from "./plugin-selection.js";
import type { CollectionProblem } from "./schemas/collection.js";
import { satisfiesHostVersionRange } from "./utils/host-version-range.js";

/** What a plugin contributes to resolving a set, read from its manifest. */
export interface CollectionPluginFacts {
  readonly id: string;
  readonly contracts: readonly string[];
  readonly requires?: readonly string[];
  /** The plugin's `covel` host range, when it declares one. */
  readonly hostRange?: string;
}

/** What a world asks of the plugins around it, read from `pluginPolicy`. */
export interface CollectionWorldFacts {
  readonly id: string;
  readonly requires: readonly string[];
  /** Plugin IDs requested by the policy and by every pack. */
  readonly requested: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

type ContractSource = Parameters<typeof providedContracts>[0];

/** Facts from a root PLUGIN.md frontmatter that is already parsed as data. */
export function collectionPluginFacts(
  manifest: Readonly<Record<string, unknown>>,
): CollectionPluginFacts {
  const contributes = isRecord(manifest.contributes)
    ? manifest.contributes
    : {};
  return {
    id: String(manifest.id),
    requires: strings(manifest.requires),
    contracts: providedContracts({
      provides: Array.isArray(manifest.provides)
        ? (manifest.provides as NonNullable<ContractSource["provides"]>)
        : [],
      extensions: Array.isArray(contributes.extensions)
        ? (contributes.extensions as NonNullable<ContractSource["extensions"]>)
        : [],
    }),
    ...(typeof manifest.covel === "string"
      ? { hostRange: manifest.covel }
      : {}),
  };
}

/** Facts from a world.yaml that is already parsed as data. */
export function collectionWorldFacts(
  manifest: Readonly<Record<string, unknown>>,
): CollectionWorldFacts {
  const policy = isRecord(manifest.pluginPolicy) ? manifest.pluginPolicy : {};
  const packs = Array.isArray(policy.packs)
    ? policy.packs.filter(isRecord)
    : [];
  return {
    id: String(manifest.id),
    requires: strings(policy.requires),
    requested: [
      ...strings(policy.requested),
      ...packs.flatMap((pack) => strings(pack.requested)),
    ],
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
  const everyPlugin = [...args.available, ...args.plugins];
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
    for (const contract of world.requires) {
      const providers = everyPlugin
        .filter((plugin) => plugin.contracts.includes(contract))
        .map((plugin) => plugin.id);
      if (providers.length === 0)
        problems.push({
          level: "error",
          packageId: world.id,
          message: `World ${world.id} requires ${contract}, and no installed or included plugin provides it.`,
        });
      else if (
        providers.length > 1 &&
        !providers.some((id) => world.requested.includes(id))
      )
        problems.push({
          level: "warning",
          packageId: world.id,
          message: `World ${world.id} requires ${contract}, which ${providers.join(", ")} all provide. Request one of them in the world's pluginPolicy, or players must choose.`,
        });
    }
    for (const pluginId of new Set(world.requested))
      if (!known.has(pluginId))
        problems.push({
          level: "warning",
          packageId: world.id,
          message: `World ${world.id} requests plugin ${pluginId}, which is neither installed nor included.`,
        });
  }
  return problems;
}
