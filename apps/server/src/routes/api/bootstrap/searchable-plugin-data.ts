import type { SearchablePluginDataResolver } from "@covel/memory";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";

/**
 * The plugin data namespaces a session's memory search reads: those declared
 * with `contributes.data.<namespace>.search` by a plugin active in the session.
 */
export function createSearchablePluginDataResolver(deps: {
  readonly store: Pick<DataStore, "getSession">;
  readonly registry: Pick<PluginRegistry, "getAll">;
}): SearchablePluginDataResolver {
  return async (sessionId) => {
    const session = await deps.store.getSession(sessionId);
    if (!session) return [];
    const active = new Set(session.activePlugins);
    const sources = [];
    for (const [pluginId, entry] of deps.registry.getAll()) {
      if (!active.has(pluginId) || entry.status === "error") continue;
      const data = entry.packageManifest?.plugin?.contributes?.data ?? {};
      for (const [namespace, declaration] of Object.entries(data)) {
        if (!declaration.search) continue;
        sources.push({
          pluginId,
          namespace,
          textField: declaration.search.text,
        });
      }
    }
    return sources.sort(
      (a, b) =>
        a.pluginId.localeCompare(b.pluginId) ||
        a.namespace.localeCompare(b.namespace),
    );
  };
}
