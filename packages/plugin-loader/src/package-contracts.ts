import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frameworkContractSchemas } from "@covel/shared/contracts";
import { isSchemaObject } from "./action-kinds.js";
import type { ParsedPluginMd } from "./types.js";

export function packageContractSchemaPath(
  sourcePath: string | undefined,
  contract: string,
  reference: string,
): string {
  if (reference.startsWith("contract:"))
    throw new Error(
      `${sourcePath}: contracts.${contract}.schema: expected a package-local schema file, not a contract reference`,
    );
  return reference;
}

function schemaBody({
  $id: _id,
  title: _title,
  ...body
}: Readonly<Record<string, unknown>>) {
  return body;
}

export function resolvePackageContractSchema<Document>(
  sourcePath: string | undefined,
  contract: string,
  document: Document,
) {
  const canonical = frameworkContractSchemas[contract];
  if (!canonical) return document;
  if (
    !isSchemaObject(document) ||
    !isDeepStrictEqual(schemaBody(document), schemaBody(canonical))
  )
    throw new Error(
      `${sourcePath}: contracts.${contract}.schema: Contract ${contract} is framework-owned and cannot be shadowed`,
    );
  return canonical;
}

export function assertDataContractSchemaPaths(
  { plugin }: ParsedPluginMd,
  sourcePath: string,
): void {
  const root = path.dirname(sourcePath);
  for (const [namespace, declaration] of Object.entries(
    plugin.contributes?.data ?? {},
  )) {
    for (const contract of declaration.accepts ?? []) {
      const declared = plugin.contracts?.[contract];
      if (
        !declared ||
        path.resolve(root, declared.schema) !==
          path.resolve(root, declaration.schema)
      )
        throw new Error(
          `${sourcePath}: contributes.data.${namespace}.schema: data namespace ${namespace} must use its accepted contract ${contract} schema`,
        );
    }
  }
}
