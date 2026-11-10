/**
 * Bootstrap stage 3: discover and register plugin packages, then derive what
 * the registry alone decides — world-data conventions, reserved builtin IDs
 * and the session event directory.
 */

import type { EventBus } from "@covel/events";
import {
  deriveBuiltinPluginIds,
  pluginDeclarations,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  conventionsOfPlugins,
  setWorldDataConventions,
} from "../../../world-data/conventions.js";
import type { ApiBootstrapConfig } from "./config.js";
import {
  createEventDirectory,
  type EventDirectory,
} from "./event-directory.js";
import {
  discoverAndRegisterPlugins,
  type DiscoverAndRegisterPluginsResult,
} from "./plugin-discovery.js";

export interface BootstrapPluginCatalog extends DiscoverAndRegisterPluginsResult {
  /** Builtin plugin IDs a community install may not claim. */
  readonly reservedPluginIds: ReturnType<typeof deriveBuiltinPluginIds>;
  readonly eventDirectory: EventDirectory;
  /** Compile one entry's event declarations; reused by plugin reloads. */
  readonly prepareEventDeclarations: (
    entry: PluginRegistryEntry,
  ) => Promise<void>;
}

export async function discoverBootstrapPlugins(
  config: Pick<ApiBootstrapConfig, "pluginsDir" | "pluginsDirs">,
  eventBus: EventBus,
): Promise<BootstrapPluginCatalog> {
  const discovered = await discoverAndRegisterPlugins({
    pluginsDir: config.pluginsDir,
    pluginsDirs: config.pluginsDirs,
    eventBus,
  });
  const { registry, discoveryMap } = discovered;
  // Worlds are read after this point. A world package without a descriptor
  // is read by the paths that the installed plugins name for their data.
  setWorldDataConventions(conventionsOfPlugins(registry));

  // Reserved plugin IDs for install-time shadow protection — derived from the
  // bundled plugins just discovered (those tagged `source: 'builtin'`), so the
  // reservation list tracks the `plugins/` directory automatically instead of a
  // hand-edited array. Injected via middleware and consumed by the plugin
  // install route to reject third-party packages that claim a builtin id.
  //
  // Derived from the registry, not discoveryMap: a builtin whose load failed is
  // quarantined out of discoveryMap, but it is still registered as an `error`
  // entry carrying its `source`. Its id must stay reserved so a community
  // package cannot claim the vacated builtin id while the directory lingers.
  const reservedPluginIds = deriveBuiltinPluginIds(registry.getAll().values());

  // Session event directory — aggregates active plugins' `events` manifest
  // contracts (union, first-wins on cross-plugin topic conflicts) so the
  // emit-event tool can validate emitted payloads. Re-aggregated per call
  // since session activation changes turn to turn; only compiled ajv
  // validators are cached.
  const eventDirectory = createEventDirectory({
    registry,
    resolvePluginDir: (pluginId) => discoveryMap.get(pluginId)?.rootPath,
  });
  const prepareEventDeclarations = async (entry: PluginRegistryEntry) => {
    await eventDirectory.prepareDeclarations(
      pluginDeclarations(entry).map(({ manifest }) => manifest),
      entry.rootPath,
    );
  };
  await Promise.all(
    [...registry.getAll().values()].map(prepareEventDeclarations),
  );
  return {
    ...discovered,
    reservedPluginIds,
    eventDirectory,
    prepareEventDeclarations,
  };
}
