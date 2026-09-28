import { readFile } from "node:fs/promises";
import type { WorldGenerationDataContract } from "@covel/create";
import type { PluginRegistry } from "@covel/plugin-loader";
import { resolveWorldDataSchema } from "./schema-registry.js";
import { parseWorldDataTarget } from "./target-uri.js";
import type { OrderedWorldDataSource } from "./types.js";

function source(
  contract: string,
  index: number,
  value?: unknown,
): OrderedWorldDataSource {
  return {
    id: `contract${index}`,
    descriptor: {
      kind: "json",
      path: `data/contract-${index}.json`,
      schema: `contract:${contract}`,
      to: `contract:${contract}`,
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
      record.value.id !== record.key
    ) {
      throw new Error(`Invalid world contractData record at index ${index}`);
    }
    const identity = `${record.contract}/${record.key}`;
    if (identities.has(identity))
      throw new Error(`Duplicate world contractData record: ${identity}`);
    identities.add(identity);
    return source(record.contract, index, record.value);
  });
}

/** Discover authorable contracts from data receivers, without naming gameplay plugins. */
export async function worldGenerationDataContracts(
  registry: Pick<PluginRegistry, "get" | "getAll"> | undefined,
): Promise<readonly WorldGenerationDataContract[]> {
  const contracts = new Set<string>();
  for (const [, entry] of registry?.getAll() ?? []) {
    if (entry.status === "error") continue;
    for (const declaration of Object.values(
      entry.packageManifest?.plugin?.contributes?.data ?? {},
    ))
      for (const contract of declaration.accepts ?? []) contracts.add(contract);
  }
  const result: WorldGenerationDataContract[] = [];
  for (const contract of [...contracts].sort()) {
    const schema = await resolveWorldDataSchema({
      source: source(contract, result.length),
      deps: { registry },
    });
    if (!schema || "level" in schema || schema.kind !== "local")
      throw new Error(`Cannot load world generation schema for ${contract}`);
    result.push({
      contract,
      schema: JSON.parse(await readFile(schema.path, "utf8")) as Record<
        string,
        unknown
      >,
      validate: (value) => Boolean(schema.validate(value)),
    });
  }
  return result;
}
