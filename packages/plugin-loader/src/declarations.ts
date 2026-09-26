import type { RuntimeManifest } from "@covel/shared";
import type { ParsedPluginMd, PluginRegistryEntry } from "./types.js";

type DeclarationEntry = Pick<
  PluginRegistryEntry,
  "packageManifest" | "manifest" | "manifests" | "dataSchemas"
>;

/** An explicitly empty runtime list means a package with no execution. */
export function pluginRuntimeManifests(
  entry: DeclarationEntry,
): readonly ParsedPluginMd[] {
  return entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
}

/** Source declarations, not effective runtime manifests with inherited fields. */
export function pluginDeclarations(
  entry: DeclarationEntry,
): readonly ParsedPluginMd[] {
  const declarations = new Map<string, ParsedPluginMd>();
  for (const parsed of [
    ...(entry.packageManifest ? [entry.packageManifest] : []),
    ...pluginRuntimeManifests(entry),
  ]) {
    if (!declarations.has(parsed.manifest.name))
      declarations.set(parsed.manifest.name, parsed);
  }
  return [...declarations.values()];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

function mergeItems<T>(
  records: readonly ParsedPluginMd[],
  field: string,
  entries: (manifest: RuntimeManifest) => readonly (readonly [string, T])[],
): Record<string, T> {
  const merged = new Map<string, { value: T; source: string }>();
  for (const record of records) {
    const source = record.sourcePath ?? record.manifest.name;
    for (const [key, value] of entries(record.manifest)) {
      const previous = merged.get(key);
      if (previous && stableJson(previous.value) !== stableJson(value)) {
        throw new Error(
          `Conflicting ${field} declaration "${key}": ${previous.source} and ${source}`,
        );
      }
      if (!previous) merged.set(key, { value, source });
    }
  }
  return Object.fromEntries(
    [...merged].map(([key, { value }]) => [key, value]),
  );
}

/** Resolve plugin-scoped contributions once, rejecting ambiguous declarations. */
export function resolvePluginDeclarations(records: readonly ParsedPluginMd[]) {
  return {
    userSettings: Object.values(
      mergeItems(records, "userSettings", (m) =>
        (m.userSettings ?? []).map((v) => [v.key, v] as const),
      ),
    ),
    dataSchemas: mergeItems(records, "dataSchemas", (m) =>
      Object.entries(m.dataSchemas ?? {}),
    ),
    worldProjections: mergeItems(records, "worldProjections", (m) =>
      Object.entries(m.worldProjections ?? {}),
    ),
    commands: Object.values(
      mergeItems(records, "commands", (m) =>
        (m.commands ?? []).map((v) => [v.name, v] as const),
      ),
    ),
    events: Object.values(
      mergeItems(records, "events", (m) =>
        (m.events ?? []).map((v) => [v.topic, v] as const),
      ),
    ),
    memoryBlocks: Object.values(
      mergeItems(records, "memoryBlocks", (m) =>
        (m.memoryBlocks ?? []).map((v) => [v.label, v] as const),
      ),
    ),
  };
}

export function validatePluginDeclarations(
  records: readonly ParsedPluginMd[],
): void {
  const names = new Map<string, ParsedPluginMd>();
  for (const record of records) {
    const previous = names.get(record.manifest.name);
    if (
      previous &&
      previous !== record &&
      previous.sourcePath !== record.sourcePath
    ) {
      throw new Error(
        `Duplicate manifest name "${record.manifest.name}": ${previous.sourcePath ?? previous.manifest.name} and ${record.sourcePath ?? record.manifest.name}`,
      );
    }
    names.set(record.manifest.name, record);
  }
  const declarations = resolvePluginDeclarations(records);
  for (const [id, projection] of Object.entries(
    declarations.worldProjections,
  )) {
    for (const [outputId, output] of Object.entries(projection.outputs)) {
      const schema = declarations.dataSchemas[output.namespace];
      if (!schema)
        throw new Error(
          `worldProjections declaration "${id}" output "${outputId}" targets undeclared dataSchemas namespace "${output.namespace}"`,
        );
      if (!schema.acceptsWorldData)
        throw new Error(
          `worldProjections declaration "${id}" output "${outputId}" targets namespace "${output.namespace}" that does not accept world data`,
        );
    }
  }
}

/** Only shared execution context is inherited; UI and capabilities remain at their source. */
export function resolvePluginRuntimeManifest(
  entry: DeclarationEntry,
  manifest: RuntimeManifest,
): RuntimeManifest {
  const declarations = resolvePluginDeclarations(pluginDeclarations(entry));
  const dataSchemas = entry.dataSchemas ?? declarations.dataSchemas;
  return {
    ...manifest,
    ...(declarations.userSettings.length
      ? { userSettings: declarations.userSettings }
      : {}),
    ...(Object.keys(dataSchemas).length ? { dataSchemas } : {}),
  };
}
