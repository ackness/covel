import { z } from "zod";
import { loadExternalDimensions } from "../../world-seed-loader.js";
import { readWorldDataSource } from "../source-reader.js";
import { parseWorldDataTarget } from "../target-uri.js";
import {
  dimensionIdSchema,
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  resolveWorldDimensionsLocale,
  worldDimensionsSchema,
} from "@covel/shared";
import { canonicalJson, sha256Hex } from "../digest.js";
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
  const providers = [...(deps?.registry?.getAll() ?? [])].filter(
    ([id, entry]) =>
      entry.status !== "error" &&
      (!deps?.activePlugins || deps.activePlugins.includes(id)) &&
      entry.packageManifest?.plugin?.provides?.some(
        (provided) =>
          (typeof provided === "string" ? provided : provided.contract) ===
          DIMENSION_CONTRACT,
      ),
  );
  if (providers.length > 1) throw new Error("Conflicting dimension providers");
  if (!providers.length) {
    if (Object.keys(definitions).length)
      throw new Error("Dimension provider unavailable");
    return plan;
  }
  const provider = providers[0]![0];
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
 * here. The result is resolved for the session's content locale: a session
 * stores one language, never the package's locale maps.
 */
export async function readEffectiveDimensions(args: {
  worldRoot: string;
  manifest: {
    id?: string;
    dimensions?: unknown;
    dimensionSources?: unknown;
    defaultLocale?: string;
  };
  sources?: readonly OrderedWorldDataSource[];
  locale?: string;
}): Promise<import("@covel/shared").WorldDimensions> {
  let definitions = parseDimensions(args.manifest.dimensions);
  const paths = z
    .record(dimensionIdSchema, z.string().min(1))
    .parse(
      args.manifest.dimensionSources === undefined
        ? {}
        : args.manifest.dimensionSources,
    );
  let externalDiagnostic: string | undefined;
  const external = await loadExternalDimensions(
    args.worldRoot,
    paths,
    args.manifest.id ?? "world",
    args.manifest.defaultLocale,
    (message) => {
      externalDiagnostic = message;
    },
  );
  if (external === null)
    throw new Error(
      `Dimension sources failed validation${externalDiagnostic ? `: ${externalDiagnostic}` : ""}`,
    );
  definitions = parseDimensions({ ...definitions, ...external });
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
      overlays: { mode: "compile", baseLocale: args.manifest.defaultLocale },
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
