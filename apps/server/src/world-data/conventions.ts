import { stat } from "node:fs/promises";
import type { PluginRegistry } from "@covel/plugin-loader";
import type {
  WorldDataDescriptor,
  WorldDataSourceDescriptor,
} from "@covel/shared";
import { resolveContainedPath } from "./safe-path.js";

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
      path: "data/dimensions.yaml",
      schema: "covel://world/dimensions",
      to: "world:metadata.dimensions",
    },
  },
  {
    id: "lorebook",
    entry: {
      kind: "yaml",
      path: "data/lorebook.yaml",
      to: "lorebook",
      key: "id",
    },
  },
  {
    id: "characters",
    entry: {
      kind: "json",
      path: "characters/characters.json",
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

/**
 * The conventional sources of a set of plugins: the kernel's, then one for
 * each data contract whose plugin names a path
 * (`contributes.data.<ns>.authoring.source`). A path two contracts claim is
 * not a convention for either: the world must say which one it means.
 */
export function conventionsOfPlugins(
  catalogue: Pick<PluginRegistry, "getAll">,
): readonly ConventionalSource[] {
  const sources: ConventionalSource[] = [...KERNEL_SOURCES];
  const entries = [...catalogue.getAll()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [pluginId, entry] of entries)
    for (const [namespace, declaration] of Object.entries(
      entry.packageManifest?.plugin?.contributes?.data ?? {},
    )) {
      const source = declaration.authoring?.source;
      if (!source) continue;
      for (const contract of declaration.accepts ?? [])
        sources.push({
          // A source ID is the namespace; the plugin ID is added when two
          // plugins use the same namespace.
          id: sources.some((item) => item.id === namespace)
            ? `${pluginId}-${namespace}`
            : namespace,
          entry: pluginSourceEntry(contract, source),
        });
    }
  const claims = new Map<string, number>();
  for (const { entry } of sources)
    claims.set(entry.path, (claims.get(entry.path) ?? 0) + 1);
  return sources.filter(({ entry }) => claims.get(entry.path) === 1);
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
    schemaVersion: 1,
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
