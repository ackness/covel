import {
  datasetToolKinds,
  datasetToolName,
  FRAMEWORK_TOOL_NAMES,
  SERVICE_IMPORT_NAME_PATTERN,
  type PluginManifest,
  type RuntimeManifest,
} from "@covel/shared";
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

/**
 * `agent.tools.datasets` names datasets of the runtime's own package, selects
 * only tools the dataset offers, and generates tool names that fit the tool
 * name rule and collide with no other tool of the runtime.
 */
export function datasetReferenceIssues(
  plugin: PluginManifest,
  runtimes: readonly {
    readonly sourcePath?: string;
    readonly manifest: RuntimeManifest;
  }[],
): string[] {
  const issues: string[] = [];
  const declared = plugin.contributes?.datasets ?? {};
  const contributed = new Set(plugin.contributes?.tools ?? []);
  const framework = new Set<string>(FRAMEWORK_TOOL_NAMES);
  for (const { sourcePath, manifest } of runtimes) {
    const references = manifest.tools?.datasets ?? [];
    if (references.length === 0) continue;
    const declaredNames = new Set([
      ...(manifest.tools?.builtin ?? []),
      ...(manifest.tools?.plugin ?? []),
    ]);
    const imports = new Set(
      (manifest.tools?.services ?? []).map((entry) => entry.name),
    );
    const seen = new Set<string>();
    for (const [i, { dataset, tools }] of references.entries()) {
      const field = `${sourcePath}: agent.tools.datasets.${i}`;
      if (seen.has(dataset)) {
        issues.push(
          `${field}: dataset ${dataset} is listed more than once; list it once`,
        );
        continue;
      }
      seen.add(dataset);
      const decl = Object.hasOwn(declared, dataset)
        ? declared[dataset]
        : undefined;
      if (!decl) {
        issues.push(
          `${field}: dataset ${dataset} is not declared in contributes.datasets`,
        );
        continue;
      }
      const offered = datasetToolKinds(decl);
      for (const [j, kind] of tools.entries())
        if (!offered.includes(kind))
          issues.push(
            `${field}.tools.${j}: dataset ${dataset} does not offer the ${kind} tool; it offers ${offered.join(", ")}`,
          );
      for (const kind of tools) {
        const name = datasetToolName(dataset, kind);
        if (!SERVICE_IMPORT_NAME_PATTERN.test(name)) {
          issues.push(
            `${field}: the tool name ${name} is longer than 64 characters; use a shorter dataset name`,
          );
          break;
        }
        const clash = framework.has(name)
          ? "a framework tool"
          : declaredNames.has(name)
            ? "a tool the runtime declares"
            : contributed.has(name)
              ? "a tool in contributes.tools"
              : imports.has(name)
                ? "an imported service tool of the runtime"
                : undefined;
        if (clash)
          issues.push(
            `${field}: the dataset tool ${name} has the name of ${clash}; rename the dataset or the other tool`,
          );
      }
    }
  }
  return issues;
}
