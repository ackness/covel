import { pluginDeclarations, type PluginRegistry } from "@covel/plugin-loader";
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
  const world = args.session.worldId
    ? await args.store.getWorld(args.session.worldId)
    : null;
  return buildSessionHookScope({
    pluginRegistry: args.pluginRegistry,
    activePluginIds: args.session.activePlugins,
    userSettings: mergePluginUserSettings(
      readWorldPluginSettings(world?.metadata),
      args.userSettings,
    ),
  });
}

/** Use the persisted activation set, including plugins with no runtimes. */
export function buildSessionHookScope(args: {
  readonly pluginRegistry?: PluginRegistry;
  readonly activePluginIds: Iterable<string>;
  readonly userSettings?: TurnInput["userSettings"];
}): HookScope {
  const activePluginIds = new Set(args.activePluginIds);
  const declarations = [...activePluginIds].flatMap((pluginId) => {
    const entry = args.pluginRegistry?.get(pluginId);
    return entry
      ? pluginDeclarations(entry).map(({ manifest }) => ({
          ...manifest,
          pluginId,
        }))
      : [];
  });
  return {
    activePluginIds,
    settings: buildHookSettings(declarations, args.userSettings),
  };
}
