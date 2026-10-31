import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  parseWorldDataTarget,
  isReservedWorldPackagePath,
} from "@covel/shared";
import {
  characterBlockRoutes,
  conventionCollisionDiagnostics,
  conventionCollisions,
  conventionsOfPlugins,
} from "./conventions.js";
import {
  descriptorSourcePaths,
  loadWorldDataDescriptor,
} from "./descriptor.js";
import {
  portableCharacterSources,
  portableContractSources,
} from "./portable-contract-data.js";
import { resolveContainedPath } from "./safe-path.js";
import {
  readWorldDataSource,
  resolveWorldDataSourcePath,
} from "./source-reader.js";
import {
  readWorldManifest,
  resolveWorldRoot,
  sourceItems,
} from "./session-import/utils.js";
import type {
  LoadedWorldDataDescriptor,
  OrderedWorldDataSource,
  WorldDataDiagnostic,
} from "./types.js";
export { worldDataRequirementNotices } from "./notices.js";

export interface WorldDataRequirementSource {
  readonly sourceId: string;
  readonly path: string;
  readonly hidden: boolean;
  readonly contracts: readonly string[];
}

/** Static facts only: no module loading, schema execution, media claims or writes. */
export interface WorldDataRequirements {
  readonly requiredContracts: readonly string[];
  readonly requiredDataContracts: readonly string[];
  readonly sources: readonly WorldDataRequirementSource[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly descriptor?: LoadedWorldDataDescriptor;
  readonly overrideRoot?: string;
  readonly worldRoot?: string;
  readonly revision?: string;
}

/** Metadata revision detects edits without reading hidden records or media bytes. */
export async function worldDataRevision(
  root: string,
  overrideRoot?: string,
): Promise<string> {
  const digest = createHash("sha256");
  let count = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 12 || ++count > 4096)
      throw new Error("World package inventory exceeds its scan limit");
    const full = relative
      ? await resolveContainedPath(root, relative, { rejectSymlinks: true })
      : root;
    if (!full) return;
    const info = await stat(full, { bigint: true });
    digest.update(
      JSON.stringify([
        relative,
        info.dev.toString(),
        info.ino.toString(),
        info.size.toString(),
        info.mtimeNs.toString(),
        info.ctimeNs.toString(),
      ]),
    );
    if (info.isDirectory()) {
      for (const entry of (await readdir(full, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      ))
        if (
          ![".git", "node_modules"].includes(entry.name) &&
          !entry.isSymbolicLink()
        )
          await visit(path.posix.join(relative, entry.name), depth + 1);
    }
  }
  await visit("", 0);
  if (overrideRoot) {
    digest.update("overrides");
    const override = await stat(overrideRoot).catch(() => undefined);
    digest.update(
      override?.isDirectory()
        ? await worldDataRevision(overrideRoot)
        : "absent",
    );
  }
  return digest.digest("hex");
}

/** A bounded walk of content files. Links and paths outside the package are never followed. */
export async function unclaimedStructuredData(
  worldRoot: string,
  claimed: ReadonlySet<string>,
): Promise<WorldDataDiagnostic[]> {
  const diagnostics: WorldDataDiagnostic[] = [];
  let visited = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    const full = await resolveContainedPath(worldRoot, directory, {
      rejectSymlinks: true,
    });
    if (!full || depth > 12 || visited >= 4096) return;
    const entries = await readdir(full, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 4096) break;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(file, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        !/\.(?:ya?ml|json)$/i.test(file) ||
        isReservedWorldPackagePath(file)
      )
        continue;
      const base = file.replace(
        /\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*(\.[^.]+)$/,
        "$1",
      );
      const isClaimed = (candidate: string) =>
        [...claimed].some((item) => {
          if (!item.includes("*"))
            return path.posix.normalize(item) === candidate;
          const [prefix = "", suffix = ""] = item.split("*");
          return (
            candidate.startsWith(prefix) &&
            candidate.endsWith(suffix) &&
            !candidate.slice(prefix.length).includes("/")
          );
        });
      if (
        isClaimed(file) ||
        isClaimed(base) ||
        /(?:\.schema|\.example)\.(?:json|ya?ml)$/i.test(file)
      )
        continue;
      diagnostics.push({
        level: "warning",
        code: "unclaimed-data-source",
        path: file,
        message:
          "This structured data file has no declaring source and is not imported.",
        hint: "Install the plugin declaring this source for validation, or add a worldData descriptor with an explicit contract target.",
      });
    }
  }
  await visit("data", 0);
  return diagnostics;
}

export async function inventoryWorldData(options: {
  readonly world?: {
    readonly dimensions?: unknown;
    readonly id?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } | null;
  readonly worldId: string;
  readonly worldRoot?: string;
  readonly worldsDirs?: readonly string[];
  readonly covelHome?: string;
  readonly registry: Pick<PluginRegistry, "get" | "getAll">;
  readonly locale?: string;
}): Promise<WorldDataRequirements> {
  const entries = new Map(options.registry.getAll());
  const catalogue = {
    get: (id: string) => entries.get(id),
    getAll: () => entries,
  };
  const worldRoot =
    options.worldRoot ??
    (options.worldsDirs?.length
      ? await resolveWorldRoot(options.worldId, options.worldsDirs)
      : null);
  const metadata = options.world?.metadata;
  const dimensions = options.world?.dimensions ?? metadata?.dimensions;
  const overrideRoot = options.covelHome
    ? path.join(options.covelHome, "world-overrides", options.worldId)
    : undefined;
  const revision = worldRoot
    ? await worldDataRevision(worldRoot, overrideRoot)
    : undefined;
  const diagnostics: WorldDataDiagnostic[] = [];
  let sources: readonly OrderedWorldDataSource[];
  let descriptor: WorldDataRequirements["descriptor"];
  if (worldRoot) {
    const manifest = await readWorldManifest(worldRoot);
    descriptor = await loadWorldDataDescriptor({
      worldRoot,
      worldId: options.worldId,
      worldDataPath: manifest.worldData,
      covelHome: options.covelHome,
      conventions: conventionsOfPlugins(catalogue),
    });
    sources =
      !manifest.worldData && descriptor.sources.length === 0
        ? [
            ...portableContractSources(metadata?.contractData),
            ...portableCharacterSources(metadata?.embeddedCharacters),
          ]
        : descriptor.sources;
    const named = await descriptorSourcePaths(worldRoot, manifest.worldData);
    diagnostics.push(
      ...descriptor.diagnostics,
      ...(await conventionCollisionDiagnostics(
        worldRoot,
        conventionCollisions(catalogue),
        named,
      )),
    );
    const claimed = new Set([
      ...sources.map((s) => s.descriptor.path),
      ...named,
      ...(descriptor.disabledPaths ?? []),
      ...conventionCollisions(catalogue).map((c) => c.path),
      ...(manifest.worldData ? [manifest.worldData] : []),
    ]);
    for (const source of sources)
      if (source.descriptor.schema && !source.descriptor.schema.includes(":"))
        claimed.add(source.descriptor.schema);
    diagnostics.push(...(await unclaimedStructuredData(worldRoot, claimed)));
  } else {
    sources = [
      ...portableContractSources(metadata?.contractData),
      ...portableCharacterSources(metadata?.embeddedCharacters),
    ];
  }
  const facts: WorldDataRequirementSource[] = [];
  const requiredContracts = new Set<string>();
  if (
    dimensions &&
    typeof dimensions === "object" &&
    Object.keys(dimensions).length
  )
    requiredContracts.add("world.dimensions@1");
  const { routes } = characterBlockRoutes(catalogue);
  for (const source of sources) {
    const entry = source.descriptor;
    if (entry.enabled === false) continue;
    if (source.inlineValue === undefined) {
      const full = await resolveWorldDataSourcePath(source, options.locale);
      if (!full) continue;
      const info = await stat(full);
      if (entry.kind === "media" && info.isDirectory()) {
        const files = await readdir(full, { withFileTypes: true });
        if (
          !files.some(
            (f) =>
              f.isFile() && /\.(?:png|jpe?g|webp|mp3|wav|mp4)$/i.test(f.name),
          )
        )
          continue;
      } else if (!info.isFile()) continue;
    }
    const contracts = new Set<string>();
    for (const uri of [entry.to, entry.indexTo]) {
      const target = uri ? parseWorldDataTarget(uri) : null;
      if (target?.kind === "contract-data") contracts.add(target.contract);
    }
    if (entry.to === "world:metadata.dimensions")
      requiredContracts.add("world.dimensions@1");
    if (entry.to === "characters" && entry.visibility !== "hidden") {
      const read =
        source.inlineValue === undefined
          ? await readWorldDataSource(source, options.locale)
          : { value: source.inlineValue, diagnostics: [] };
      diagnostics.push(...read.diagnostics);
      for (const route of routes)
        if (
          sourceItems(read.value).some(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              Object.hasOwn(item, route.field),
          )
        )
          contracts.add(route.contract);
    }
    facts.push({
      sourceId: source.id,
      path: entry.path,
      hidden: entry.visibility === "hidden",
      contracts: [...contracts],
    });
  }
  return {
    requiredContracts: [...requiredContracts],
    requiredDataContracts: [...new Set(facts.flatMap((f) => f.contracts))],
    sources: facts,
    diagnostics,
    ...(worldRoot ? { worldRoot, revision, overrideRoot } : {}),
    ...(descriptor ? { descriptor } : {}),
  };
}
