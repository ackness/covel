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

/** Plugin declarations have one explicit owner: the root PLUGIN.md. */
export function resolvePluginDeclarations(records: readonly ParsedPluginMd[]) {
  const root =
    records.find((record) => record.plugin)?.manifest ??
    records.find((record) => record.manifest.name === record.manifest.pluginId)
      ?.manifest;
  return {
    extensions: root?.extensions ?? [],
    userSettings: root?.userSettings ?? [],
    dataSchemas: root?.dataSchemas ?? {},
    worldProjections: root?.worldProjections ?? {},
    commands: root?.commands ?? [],
    events: root?.events ?? [],
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
  const plugin = records.find((record) => record.plugin)?.plugin;
  for (const command of plugin?.contributes?.commands ?? []) {
    if (!plugin?.contributes?.actions?.includes(command.action))
      throw new Error(
        `Command ${command.name} action ${command.action} must be declared in contributes.actions`,
      );
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
