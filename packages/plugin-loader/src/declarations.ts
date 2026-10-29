import type { RuntimeManifest } from "@covel/shared";
import type {
  ParsedPluginMd,
  ParsedRuntimeMd,
  PluginRegistryEntry,
} from "./types.js";

type DeclarationEntry = Pick<
  PluginRegistryEntry,
  "packageManifest" | "manifests" | "dataSchemas" | "datasets"
>;

/** Package declarations are never inferred to be executable. */
export function pluginRuntimeManifests(
  entry: DeclarationEntry,
): readonly ParsedRuntimeMd[] {
  return entry.manifests ?? [];
}

/** Source declarations, not effective runtime manifests with inherited fields. */
export function pluginDeclarations(
  entry: DeclarationEntry,
): readonly ParsedPluginMd[] {
  return entry.packageManifest ? [entry.packageManifest] : [];
}

/** Plugin declarations have one explicit owner: the root PLUGIN.md. */
export function resolvePluginDeclarations(records: readonly ParsedPluginMd[]) {
  const root = records[0]?.manifest;
  return {
    extensions: root?.extensions ?? [],
    userSettings: root?.userSettings ?? [],
    dataSchemas: root?.dataSchemas ?? {},
    datasets: root?.datasets ?? {},
    worldProjections: root?.worldProjections ?? {},
    commands: root?.commands ?? [],
    events: root?.events ?? [],
  };
}

export function validatePluginDeclarations(root: ParsedPluginMd): void {
  const plugin = root.plugin;
  for (const command of plugin?.contributes?.commands ?? []) {
    if (!plugin?.contributes?.actions?.includes(command.action))
      throw new Error(
        `Command ${command.name} action ${command.action} must be declared in contributes.actions`,
      );
  }
  const declarations = resolvePluginDeclarations([root]);
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
  const datasets = entry.datasets ?? declarations.datasets;
  return {
    ...manifest,
    ...(declarations.userSettings.length
      ? { userSettings: declarations.userSettings }
      : {}),
    ...(Object.keys(dataSchemas).length ? { dataSchemas } : {}),
    ...(Object.keys(datasets).length ? { datasets } : {}),
  };
}
