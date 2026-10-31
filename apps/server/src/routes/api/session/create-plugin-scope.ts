import type { PluginRegistryEntry } from "@covel/plugin-loader";
import { providedContracts } from "@covel/shared";

/** Publications and authorization that a frozen creation plan depends on. */
export function captureCreatePluginScope(options: {
  readonly entries: ReadonlyMap<string, PluginRegistryEntry>;
  readonly selected: readonly string[];
  readonly requiredContracts: readonly string[];
  readonly requiredDataContracts: readonly string[];
  readonly schemaContracts: readonly string[];
  readonly authorized: ReadonlySet<string>;
}): ReadonlyMap<
  string,
  { readonly entry: PluginRegistryEntry; readonly authorized: boolean }
> {
  const ids = new Set(options.selected);
  const contracts = new Set(options.requiredContracts);
  const dataContracts = new Set(options.requiredDataContracts);
  const schemaContracts = new Set([
    ...dataContracts,
    ...options.schemaContracts,
  ]);
  const declarations = [...options.entries].map(([id, entry]) => {
    const plugin = entry.packageManifest?.plugin;
    return {
      id,
      requires: plugin?.requires ?? [],
      provides: providedContracts({
        provides: plugin?.provides,
        extensions: plugin?.contributes?.extensions,
      }),
      accepts: Object.values(plugin?.contributes?.data ?? {}).flatMap(
        (data) => data.accepts ?? [],
      ),
      schemas: Object.keys(plugin?.contracts ?? {}),
    };
  });
  // Receivers can be deferred or awaiting approval. Their dependencies and
  // candidate providers still contributed to this plan's admission decision.
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (
        !ids.has(declaration.id) &&
        (declaration.provides.some((contract) => contracts.has(contract)) ||
          declaration.accepts.some((contract) => dataContracts.has(contract)) ||
          declaration.schemas.some((contract) => schemaContracts.has(contract)))
      ) {
        ids.add(declaration.id);
        changed = true;
      }
      if (!ids.has(declaration.id)) continue;
      for (const contract of declaration.requires) {
        if (contracts.has(contract)) continue;
        contracts.add(contract);
        changed = true;
      }
    }
  }
  return new Map(
    [...options.entries]
      .filter(([id]) => ids.has(id))
      .map(([id, entry]) => [
        id,
        { entry, authorized: options.authorized.has(id) },
      ]),
  );
}
