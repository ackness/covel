import { readFile } from "node:fs/promises";
import { KERNEL_WORLD_DATA_PATHS } from "@covel/shared";
import type { WorldGenerationDataContract } from "@covel/create";
import type { PluginRegistry } from "@covel/plugin-loader";
import { describeAuthoringSurface } from "../authoring/describe.js";
import { conventionsOfPlugins } from "./conventions.js";
import { resolveWorldDataSchema } from "./schema-registry.js";
import { parseWorldDataTarget } from "./target-uri.js";
import type { OrderedWorldDataSource } from "./types.js";

function source(
  contract: string,
  index: number,
  value?: unknown,
  lorebook = false,
): OrderedWorldDataSource {
  return {
    id: `contract${index}`,
    descriptor: {
      kind: "json",
      path: `data/contract-${index}.json`,
      schema: `contract:${contract}`,
      to: `contract:${contract}${lorebook ? "+lorebook" : ""}`,
      key: "id",
    },
    order: index,
    resolvedOrder: index,
    origin: "world",
    overridden: false,
    pathOrigin: { descriptorRoot: ".", origin: "world" },
    ...(value === undefined ? {} : { inlineValue: value }),
  };
}

/**
 * The characters of a world that lives in a store (`embeddedCharacters`), as
 * a source: the same planning as a world's character file, so the plugin
 * data a character record carries reaches its receivers too.
 */
export function portableCharacterSources(
  value: unknown,
): readonly OrderedWorldDataSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("embeddedCharacters must be an array");
  return [
    {
      id: "characters",
      descriptor: {
        kind: "json",
        path: KERNEL_WORLD_DATA_PATHS.characters,
        to: "characters",
        key: "id",
      },
      order: 0,
      resolvedOrder: 0,
      origin: "world",
      overridden: false,
      pathOrigin: { descriptorRoot: ".", origin: "world" },
      inlineValue: value,
    },
  ];
}

/** Portable records use the same schema, receiver and write planning as files. */
export function portableContractSources(
  value: unknown,
): readonly OrderedWorldDataSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("world contractData must be an array");
  const identities = new Set<string>();
  return value.map((record, index) => {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.contract !== "string" ||
      parseWorldDataTarget(`contract:${record.contract}`)?.kind !==
        "contract-data" ||
      record.contract.includes("+") ||
      typeof record.key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record.key) ||
      !record.value ||
      typeof record.value !== "object" ||
      Array.isArray(record.value) ||
      record.value.id !== record.key ||
      (record.lorebook !== undefined && record.lorebook !== true)
    ) {
      throw new Error(`Invalid world contractData record at index ${index}`);
    }
    const identity = `${record.contract}/${record.key}`;
    if (identities.has(identity))
      throw new Error(`Duplicate world contractData record: ${identity}`);
    identities.add(identity);
    return source(
      record.contract,
      index,
      record.value,
      record.lorebook === true,
    );
  });
}

/**
 * The contracts the world generator may be asked to produce: those whose
 * receiving plugin declares `authoring.generate`. Everything the generator
 * learns about a contract comes from that declaration, so no gameplay plugin
 * is named here.
 */
export async function worldGenerationDataContracts(
  registry: Pick<PluginRegistry, "get" | "getAll"> | undefined,
  onWarning?: (message: string) => void,
): Promise<readonly WorldGenerationDataContract[]> {
  if (!registry) return [];
  const surface = await describeAuthoringSurface(registry);
  for (const issue of surface.diagnostics ?? [])
    onWarning?.(`${issue.pluginId}/${issue.namespace}: ${issue.message}`);
  // A file the generator writes without a descriptor entry is read back by
  // these conventions, so a path that is not one of them is not passed on.
  const conventions = conventionsOfPlugins(registry);
  const result: WorldGenerationDataContract[] = [];
  const seen = new Set<string>();
  for (const item of surface.contracts) {
    if (
      !item.generate ||
      seen.has(item.contract) ||
      registry.get(item.pluginId)?.status === "error"
    )
      continue;
    seen.add(item.contract);
    const declared = item.source?.entry;
    const conventional =
      declared !== undefined &&
      conventions.some(
        ({ entry }) => entry.path === declared.path && entry.to === declared.to,
      );
    try {
      const schema = await resolveWorldDataSchema({
        source: source(item.contract, result.length),
        deps: { registry },
      });
      if (!schema || "level" in schema || schema.kind !== "local")
        throw new Error(
          `Cannot load world generation schema for ${item.contract}`,
        );
      result.push({
        contract: item.contract,
        schema: JSON.parse(await readFile(schema.path, "utf8")) as Record<
          string,
          unknown
        >,
        validate: (value) => Boolean(schema.validate(value)),
        title: item.title,
        ...(item.hint ? { hint: item.hint } : {}),
        ...(item.example !== undefined ? { example: item.example } : {}),
        // A session has every `kind: core` plugin already.
        ...(registry.get(item.pluginId)?.packageManifest?.plugin?.kind ===
        "core"
          ? {}
          : { pluginId: item.pluginId }),
        lorebook: declared?.to.endsWith("+lorebook") === true,
        ...(item.characterField ? { characterField: item.characterField } : {}),
        ...(declared &&
        conventional &&
        (declared.kind === "yaml" || declared.kind === "json")
          ? {
              source: {
                kind: declared.kind,
                path: declared.path,
                ...(declared.localeArrayKeys
                  ? { localeArrayKeys: declared.localeArrayKeys }
                  : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      const message = `${item.pluginId}/${item.namespace} (${item.contract}): ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[authoring] Skipping ${message}`);
      onWarning?.(message);
    }
  }
  return result;
}
