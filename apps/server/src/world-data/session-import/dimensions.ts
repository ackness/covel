import { readWorldDataSource } from "../source-reader.js";
import { parseWorldDataTarget } from "../target-uri.js";
import {
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  resolveWorldDimensionsLocale,
  worldDimensionsSchema,
} from "@covel/shared";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { PluginRegistry } from "@covel/plugin-loader";
import { DimensionProviderConflictError } from "../dimension-provider-conflict.js";
import type { OrderedWorldDataSource } from "../types.js";
import type { ImportPlan, WorldDataImportPreflightDeps } from "./types.js";

function parseDimensions(value: unknown) {
  const parsed = worldDimensionsSchema.safeParse(
    value === undefined ? {} : value,
  );
  if (!parsed.success)
    throw new Error(`invalid world dimensions: ${parsed.error.message}`);
  return parsed.data;
}

/** Installed plugins of a set that provide `world.dimensions@1`, in registry order. */
export function dimensionProvidersOf(
  registry: Pick<PluginRegistry, "getAll"> | undefined,
  activePlugins: readonly string[] | undefined,
): string[] {
  return [...(registry?.getAll() ?? [])]
    .filter(
      ([id, entry]) =>
        entry.status !== "error" &&
        (!activePlugins || activePlugins.includes(id)) &&
        entry.packageManifest?.plugin?.provides?.some(
          (provided) =>
            (typeof provided === "string" ? provided : provided.contract) ===
            DIMENSION_CONTRACT,
        ),
    )
    .map(([id]) => id);
}

/**
 * The one plugin that keeps the session's dimensions, if any.
 *
 * @throws {DimensionProviderConflictError} when several active plugins do.
 */
export function activeDimensionProvider(
  deps: WorldDataImportPreflightDeps | undefined,
): string | undefined {
  const providers = dimensionProvidersOf(deps?.registry, deps?.activePlugins);
  if (providers.length > 1) throw new DimensionProviderConflictError(providers);
  return providers[0];
}

/**
 * All author entry points resolve to one effective declaration before session
 * import. `locale` is the session's content locale: the records written here
 * hold that one language, never the package's locale maps.
 */
export function appendDimensionPlan(
  plan: ImportPlan,
  dimensions: unknown,
  deps: WorldDataImportPreflightDeps | undefined,
  locale: string | undefined,
): ImportPlan {
  const definitions = resolveWorldDimensionsLocale(
    parseDimensions(dimensions),
    locale,
  );
  const provider = activeDimensionProvider(deps);
  if (!provider) {
    // The kernel keeps no dimensions of its own: without a provider they are
    // left out, and the session starts without them.
    const ids = Object.keys(definitions);
    if (ids.length === 0) return plan;
    return {
      ...plan,
      skippedDimensions: ids,
      diagnostics: [
        ...plan.diagnostics,
        {
          level: "warning",
          code: "dimension-provider-missing",
          message: `No active plugin provides ${DIMENSION_CONTRACT}, so the world's dimensions (${ids.join(", ")}) are left out of the session`,
          hint: `Turn on a plugin that provides ${DIMENSION_CONTRACT} to use them.`,
        },
      ],
    };
  }
  const source: OrderedWorldDataSource = {
    id: "dimensions",
    origin: "world",
    overridden: false,
    order: 0,
    resolvedOrder: 0,
    pathOrigin: { descriptorRoot: ".", origin: "world" },
    descriptor: {
      kind: "json",
      path: "world.yaml",
      to: "world:metadata.dimensions",
      merge: "replace",
    },
  };
  return {
    ...plan,
    writes: [
      ...plan.writes,
      ...Object.entries(definitions).map(([key, definition]) => ({
        kind: "plugin-data" as const,
        target: `contract:${DIMENSION_CONTRACT}`,
        source,
        sourceDigest: sha256Hex(canonicalJson(definition)),
        pluginId: provider,
        namespace: DIMENSION_DATA_NAMESPACE,
        key,
        value: { definition, value: definition.initialValue, version: 1 },
      })),
    ],
  };
}

/**
 * Match world loading precedence, but validate only dimension declarations
 * here: the `dimensions` of `world.yaml`, replaced by a dimensions source
 * (`data/dimensions.yaml`) when the package has one. The result is resolved
 * for the session's content locale: a session stores one language, never
 * the package's locale maps.
 */
export async function readEffectiveDimensions(args: {
  worldRoot: string;
  manifest: {
    dimensions?: unknown;
    defaultLocale?: string;
    /** The world's editions; without them, its default locale only. */
    editions?: readonly string[];
  };
  sources?: readonly OrderedWorldDataSource[];
  locale?: string;
}): Promise<import("@covel/shared").WorldDimensions> {
  const declared = [
    ...new Set([
      ...(args.manifest.defaultLocale ? [args.manifest.defaultLocale] : []),
      ...(args.manifest.editions ?? []),
    ]),
  ];
  let definitions = parseDimensions(args.manifest.dimensions);
  for (const source of args.sources ?? []) {
    const target = parseWorldDataTarget(source.descriptor.to);
    if (
      target?.kind !== "world-metadata" ||
      target.path.join(".") !== "dimensions"
    )
      continue;
    // Every overlay is compiled in: labels keep all languages. The values
    // are resolved for the session's locale at the end of this function.
    const read = await readWorldDataSource(source, undefined, {
      overlays: {
        mode: "compile",
        baseLocale: args.manifest.defaultLocale,
        declared,
      },
    });
    if (read.diagnostics.some((diagnostic) => diagnostic.level === "error"))
      throw new Error(
        read.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      );
    definitions = parseDimensions(read.value);
  }
  return resolveWorldDimensionsLocale(
    definitions,
    args.locale ?? args.manifest.defaultLocale,
  );
}
