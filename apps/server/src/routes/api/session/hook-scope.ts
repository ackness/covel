import { pluginDeclarations, type PluginRegistry } from "@covel/plugin-loader";
import { buildHookSettings, type HookScope } from "@covel/runtime";
import type { TurnInput } from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { loadSessionPluginUserSettings } from "../plugin-user-settings.js";
import { runnablePluginIds } from "./plugins.js";

/**
 * The hook scope of `session`: the hooks of its runnable plugins
 * (`runnablePluginIds`, including plugins with no runtimes), each plugin's
 * settings resolved from `userSettings`, and the session's content locale,
 * which every hook receives as `ctx.locale`. An execution passes the
 * settings snapshot it runs with.
 */
export function buildSessionHookScope(args: {
  readonly pluginRegistry: Pick<PluginRegistry, "get" | "getAll"> | undefined;
  readonly session: Pick<SessionRecord, "activePlugins" | "locale">;
  readonly userSettings?: TurnInput["userSettings"];
}): HookScope {
  const { pluginRegistry, session } = args;
  const activePluginIds = new Set(
    pluginRegistry
      ? runnablePluginIds([...session.activePlugins], pluginRegistry)
      : session.activePlugins,
  );
  const declarations = [...activePluginIds].flatMap((pluginId) => {
    const entry = pluginRegistry?.get(pluginId);
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
    locale: session.locale,
  };
}

/**
 * {@link buildSessionHookScope} for hooks fired outside an execution, with
 * the player's `userSettings` over the world's defaults. Resolve it before
 * mutating: a settings read failure must not follow a durable write.
 */
export async function loadSessionHookScope(args: {
  readonly store: Pick<DataStore, "getWorld">;
  readonly pluginRegistry: Pick<PluginRegistry, "get" | "getAll"> | undefined;
  readonly session: Pick<SessionRecord, "activePlugins" | "worldId" | "locale">;
  readonly userSettings?: TurnInput["userSettings"];
}): Promise<HookScope> {
  return buildSessionHookScope({
    pluginRegistry: args.pluginRegistry,
    session: args.session,
    userSettings: await loadSessionPluginUserSettings(
      args.store,
      args.session,
      args.userSettings,
    ),
  });
}
