import { readFile } from "node:fs/promises";
import type { WorldGenerationDataContract } from "@covel/create";
import type { PluginRegistry } from "@covel/plugin-loader";
import { describeAuthoringSurface } from "../authoring/describe.js";
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
): Promise<readonly WorldGenerationDataContract[]> {
  if (!registry) return [];
  const surface = await describeAuthoringSurface(registry);
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
      pluginId: item.pluginId,
      lorebook: item.source?.entry.to.endsWith("+lorebook") === true,
      ...(item.source &&
      (item.source.entry.kind === "yaml" || item.source.entry.kind === "json")
        ? {
            source: {
              kind: item.source.entry.kind,
              path: item.source.entry.path,
            },
          }
        : {}),
    });
  }
  return result;
}
