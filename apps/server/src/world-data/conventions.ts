import { KERNEL_WORLD_DATA_PATHS, compareText } from "@covel/shared";
import { stat } from "node:fs/promises";
import type { PluginRegistry } from "@covel/plugin-loader";
import type {
  WorldDataDescriptor,
  WorldDataSourceDescriptor,
} from "@covel/shared";
import { resolveContainedPath } from "./safe-path.js";
import type { WorldDataDiagnostic } from "./types.js";

/**
 * Well-known paths of a world package.
 *
 * A file at one of these paths is a data source without an entry in a
 * descriptor: `data/dimensions.yaml` holds the dimensions, `data/quests.yaml`
 * the records of the contract whose plugin names that path. A world with no
 * `worldData` in `world.yaml` is read by these conventions, and the result
 * is the descriptor that the same entries would give when written out.
 *
 * A descriptor replaces the conventions for that world: it is the place for a
 * file with another name, a hidden source, an order between sources.
 */
export interface ConventionalSource {
  readonly id: string;
  readonly entry: WorldDataSourceDescriptor;
}

/** Destinations the kernel owns; no plugin has to be installed for them. */
export const KERNEL_SOURCES: readonly ConventionalSource[] = [
  {
    id: "dimensions",
    entry: {
      kind: "yaml",
      path: KERNEL_WORLD_DATA_PATHS.dimensions,
      schema: "covel://world/dimensions",
      to: "world:metadata.dimensions",
    },
  },
  {
    id: "lorebook",
    entry: {
      kind: "yaml",
      path: KERNEL_WORLD_DATA_PATHS.lorebook,
      to: "lorebook",
      key: "id",
    },
  },
  {
    id: "characters",
    entry: {
      kind: "json",
      path: KERNEL_WORLD_DATA_PATHS.characters,
      to: "characters",
      key: "id",
    },
  },
];

/** What a plugin says about the file of one data contract (`authoring.source`). */
export interface AuthoringSourceDeclaration {
  readonly kind: "yaml" | "json" | "media";
  readonly path: string;
  readonly key?: string;
  readonly localeArrayKeys?: readonly string[];
  readonly visibility?: "public" | "hidden";
  readonly lorebook?: boolean;
}

/** The descriptor entry for a contract's file at the path its plugin names. */
export function pluginSourceEntry(
  contract: string,
  source: AuthoringSourceDeclaration,
): WorldDataSourceDescriptor {
  if (source.kind === "media")
    return {
      kind: "media",
      path: source.path,
      to: "media",
      indexTo: `contract:${contract}`,
      key: source.key ?? "filename",
    };
  return {
    kind: source.kind,
    path: source.path,
    schema: `contract:${contract}`,
    to: `contract:${contract}${source.lorebook ? "+lorebook" : ""}`,
    ...(source.key ? { key: source.key } : {}),
    ...(source.localeArrayKeys
      ? { localeArrayKeys: [...source.localeArrayKeys] }
      : {}),
    ...(source.visibility === "hidden" ? { visibility: "hidden" } : {}),
  };
}

/** A conventional source and the plugin declaration that names it. */
interface Claim {
  readonly source: ConventionalSource;
  /** The declaring plugin and `pluginId/namespace (contract)`; absent for the kernel's. */
  readonly claimant?: { readonly pluginId: string; readonly label: string };
}

/**
 * The kernel's sources, then one for each data contract whose plugin names a
 * path (`contributes.data.<ns>.authoring.source`). Only plugins that loaded
 * count, and of those only `activePlugins` when it is given: a plugin the
 * session does not run has no say in how its world is read. A plugin cannot
 * name a kernel path; the manifest schema rejects it.
 */
function claimsOf(
  catalogue: Pick<PluginRegistry, "getAll">,
  activePlugins: readonly string[] | undefined,
): Claim[] {
  const claims: Claim[] = KERNEL_SOURCES.map((source) => ({ source }));
  const entries = [...catalogue.getAll()]
    .filter(
      ([pluginId, entry]) =>
        entry.status !== "error" &&
        (!activePlugins || activePlugins.includes(pluginId)),
    )
    .sort(([a], [b]) => compareText(a, b));
  for (const [pluginId, entry] of entries)
    for (const [namespace, declaration] of Object.entries(
      entry.packageManifest?.plugin?.contributes?.data ?? {},
    )) {
      const source = declaration.authoring?.source;
      if (!source) continue;
      for (const contract of declaration.accepts ?? [])
        claims.push({
          source: {
            // A source ID is the namespace; the plugin ID is added when two
            // plugins use the same namespace.
            id: claims.some((item) => item.source.id === namespace)
              ? `${pluginId}-${namespace}`
              : namespace,
            entry: pluginSourceEntry(contract, source),
          },
          claimant: {
            pluginId,
            label: `${pluginId}/${namespace} (${contract})`,
          },
        });
    }
  return claims;
}

function claimCounts(claims: readonly Claim[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { source } of claims)
    counts.set(source.entry.path, (counts.get(source.entry.path) ?? 0) + 1);
  return counts;
}

/**
 * The conventional sources of a set of plugins: the kernel's, then one for
 * each data contract whose plugin names a path. `activePlugins` limits the
 * plugins to those of one session; without it every plugin that loaded
 * counts. A path two contracts claim is not a convention for either: the
 * world must say which one it means (see `conventionCollisions`).
 */
export function conventionsOfPlugins(
  catalogue: Pick<PluginRegistry, "getAll">,
  activePlugins?: readonly string[],
): readonly ConventionalSource[] {
  const claims = claimsOf(catalogue, activePlugins);
  const counts = claimCounts(claims);
  return claims
    .filter(({ source }) => counts.get(source.entry.path) === 1)
    .map(({ source }) => source);
}

/** A path that more than one data contract of the same plugin set names. */
export interface ConventionCollision {
  readonly path: string;
  /** Each declaration that names it, labelled `pluginId/namespace (contract)`. */
  readonly claimants: readonly {
    readonly pluginId: string;
    readonly label: string;
  }[];
}

/** The paths that `conventionsOfPlugins` leaves out because two contracts name them. */
export function conventionCollisions(
  catalogue: Pick<PluginRegistry, "getAll">,
  activePlugins?: readonly string[],
): readonly ConventionCollision[] {
  const claims = claimsOf(catalogue, activePlugins);
  const counts = claimCounts(claims);
  const byPath = new Map<string, NonNullable<Claim["claimant"]>[]>();
  for (const { source, claimant } of claims)
    if (claimant && (counts.get(source.entry.path) ?? 0) > 1)
      byPath.set(source.entry.path, [
        ...(byPath.get(source.entry.path) ?? []),
        claimant,
      ]);
  return [...byPath]
    .sort(([a], [b]) => compareText(a, b))
    .map(([path, claimants]) => ({ path, claimants }));
}

/**
 * A warning for each collision whose file or directory the package has: the
 * file is imported for none of the contracts that name it. Never an error: a
 * session still starts, without that file.
 */
export async function conventionCollisionDiagnostics(
  worldRoot: string,
  collisions: readonly ConventionCollision[],
): Promise<WorldDataDiagnostic[]> {
  const diagnostics: WorldDataDiagnostic[] = [];
  for (const collision of collisions) {
    const full = await resolveContainedPath(worldRoot, collision.path, {
      rejectSymlinks: true,
    });
    if (!full || !(await stat(full).catch(() => undefined))) continue;
    diagnostics.push({
      level: "warning",
      code: "convention-collision",
      path: collision.path,
      message: `${collision.path} is not imported: more than one plugin names it as the file of its data (${collision.claimants.map((item) => item.label).join(", ")})`,
      hint: "Write a worldData descriptor that lists this file with the contract it is for.",
    });
  }
  return diagnostics;
}

let conventions: readonly ConventionalSource[] = KERNEL_SOURCES;

/**
 * Set the conventional sources of this process: the kernel's and those the
 * installed plugins declare (`contributes.data.<ns>.authoring.source`).
 * Call it when the plugin pool is known.
 */
export function setWorldDataConventions(
  sources: readonly ConventionalSource[],
): void {
  conventions = sources;
}

export function worldDataConventions(): readonly ConventionalSource[] {
  return conventions;
}

/**
 * Import order for conventional sources, which have no `after`: dimensions,
 * then media (records point at media files by name), then the rest in the
 * order given, the kernel's character records last.
 */
function rank(source: ConventionalSource): number {
  if (source.entry.to === "world:metadata.dimensions") return 0;
  if (source.entry.kind === "media") return 1;
  if (source.entry.to === "characters") return 3;
  return 2;
}

async function exists(
  worldRoot: string,
  source: ConventionalSource,
): Promise<boolean> {
  const full = await resolveContainedPath(worldRoot, source.entry.path, {
    rejectSymlinks: true,
  });
  if (!full) return false;
  try {
    const info = await stat(full);
    return source.entry.kind === "media" ? info.isDirectory() : info.isFile();
  } catch {
    return false;
  }
}

/**
 * The conventional sources whose file or directory the package has.
 * `known` is the list to read by: a caller that holds the plugin registry
 * passes its conventions; without it the list of the process is used.
 */
async function presentConventionalSources(
  worldRoot: string,
  known: readonly ConventionalSource[] = conventions,
): Promise<readonly ConventionalSource[]> {
  const present: ConventionalSource[] = [];
  for (const source of known)
    if (await exists(worldRoot, source)) present.push(source);
  return present
    .map((source, index) => ({ source, index }))
    .sort((a, b) => rank(a.source) - rank(b.source) || a.index - b.index)
    .map(({ source }) => source);
}

/** The descriptor that the package's conventional files stand for, if it has any. */
export async function conventionalDescriptor(
  worldRoot: string,
  known?: readonly ConventionalSource[],
): Promise<WorldDataDescriptor | undefined> {
  const sources = await presentConventionalSources(worldRoot, known);
  if (sources.length === 0) return undefined;
  return {
    sources: Object.fromEntries(
      sources.map((source) => [source.id, source.entry]),
    ),
  };
}

/**
 * Whether the package has world data to import: a descriptor named in
 * `world.yaml`, or a file at a conventional path.
 */
export async function worldHasData(
  worldRoot: string,
  worldDataPath: string | undefined,
  known?: readonly ConventionalSource[],
): Promise<boolean> {
  return (
    Boolean(worldDataPath) ||
    (await presentConventionalSources(worldRoot, known)).length > 0
  );
}
