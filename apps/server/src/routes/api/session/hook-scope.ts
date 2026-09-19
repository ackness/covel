import type { PluginRegistry } from "@covel/plugin-loader";
import { buildHookSettings, type HookScope } from "@covel/runtime";
import type { TurnInput } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import {
  mergePluginUserSettings,
  readWorldPluginSettings,
} from "../plugin-user-settings.js";

/** Resolve before mutating: a settings read failure must not follow a durable write. */
export async function loadSessionHookScope(args: {
  readonly store: DataStore;
  readonly pluginRegistry: PluginRegistry | undefined;
  readonly session: Pick<SessionRecord, "activePlugins" | "worldId">;
  readonly userSettings?: TurnInput["userSettings"];
}): Promise<HookScope> {
  // Read the supplied persisted activation set, not a potentially stale
  // process-local registry view. Lifecycle hooks also cover hook-only plugins.
  const activePluginIds = new Set(args.session.activePlugins);
  const runtimes = [...activePluginIds].flatMap((pluginId) => {
    const entry = args.pluginRegistry?.get(pluginId);
    if (!entry) return [];
    const manifests = entry.manifests?.length
      ? entry.manifests
      : entry.manifest
        ? [entry.manifest]
        : [];
    return manifests.map(({ manifest }) => ({ ...manifest, pluginId }));
  });
  const world = args.session.worldId
    ? await args.store.getWorld(args.session.worldId)
    : null;
  return {
    activePluginIds,
    settings: buildHookSettings(
      runtimes,
      mergePluginUserSettings(
        readWorldPluginSettings(world?.metadata),
        args.userSettings,
      ),
    ),
  };
}
