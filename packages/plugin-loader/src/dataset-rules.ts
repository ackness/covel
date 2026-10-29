import type { PluginManifest } from "@covel/shared";
import path from "node:path";

/**
 * Declarative `contributes.datasets` rules that need no JSON Schema compiler.
 * Loading and static validation both call these so they reach one verdict.
 */

/**
 * A dataset `key` must name a required property of the record schema. A schema
 * whose top level has no `properties` (`$ref`, `allOf`, …) cannot be judged
 * without a schema compiler, so it passes.
 */
export function datasetKeyIssue(
  source: string,
  name: string,
  declaration: { readonly schema: string; readonly key?: string },
  document: unknown,
): string | undefined {
  const { key } = declaration;
  if (key === undefined) return undefined;
  if (typeof document !== "object" || document === null) return undefined;
  const { properties, required } = document as {
    properties?: unknown;
    required?: unknown;
  };
  if (typeof properties !== "object" || properties === null) return undefined;
  if (
    Object.hasOwn(properties, key) &&
    Array.isArray(required) &&
    required.includes(key)
  )
    return undefined;
  return `${source}: contributes.datasets.${name}.key: ${key} is not a required property of ${declaration.schema}; add it to the schema's properties and required, or remove key`;
}

/** One namespace has one schema: `contributes.data` and `datasets` must share it. */
export function datasetSchemaIssues(
  source: string,
  rootDir: string,
  contributes: PluginManifest["contributes"],
): string[] {
  const issues: string[] = [];
  for (const [name, dataset] of Object.entries(contributes?.datasets ?? {})) {
    const data =
      contributes?.data && Object.hasOwn(contributes.data, name)
        ? contributes.data[name]
        : undefined;
    if (
      data &&
      path.resolve(rootDir, data.schema) !==
        path.resolve(rootDir, dataset.schema)
    )
      issues.push(
        `${source}: data namespace ${name} and dataset ${name} must use the same schema`,
      );
  }
  return issues;
}
