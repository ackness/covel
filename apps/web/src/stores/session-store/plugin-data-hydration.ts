import * as api from "@/services/api";
import { loadPluginDataForSession } from "@/stores/plugin-data-store.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import type { SessionDispatch } from "./types.js";

interface PluginNamespace {
  pluginId: string;
  namespace: string;
}

function namespaceKey(pluginId: string, namespace: string): string {
  return `${pluginId}\u0000${namespace}`;
}

function collectSpecNamespaces(specs: api.UISpecsResponse): PluginNamespace[] {
  const namespaces = new Map<string, PluginNamespace>();
  for (const entry of [...specs.right, ...(specs.message ?? [])]) {
    for (const spec of entry.specs) {
      const namespace = spec.dataSource?.namespace;
      if (!namespace) continue;
      namespaces.set(namespaceKey(entry.pluginId, namespace), {
        pluginId: entry.pluginId,
        namespace,
      });
    }
  }
  return [...namespaces.values()];
}

async function hydratePluginDataNamespaces(
  sessionId: string,
  namespaces: readonly PluginNamespace[],
  dispatch: SessionDispatch,
  isCurrent: () => boolean,
): Promise<void> {
  await Promise.all(
    namespaces.map(({ pluginId, namespace }) =>
      refreshSessionResource(
        dispatch,
        ["plugin-data", sessionId, pluginId, namespace],
        {
          isCurrent,
          read: () => api.listPluginData(sessionId, pluginId, namespace),
          apply: (rows) => {
            loadPluginDataForSession(
              sessionId,
              pluginId,
              namespace,
              rows.map((row) => ({ key: row.key, value: row.value })),
            );
            dispatch({
              type: "REPLACE_PLUGIN_DATA_NAMESPACE",
              pluginId,
              namespace,
              data: Object.fromEntries(rows.map((row) => [row.key, row.value])),
            });
          },
        },
      ),
    ),
  );
}

export async function hydratePluginDataForUiSpecs(
  sessionId: string,
  dispatch: SessionDispatch,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  let namespaces: PluginNamespace[] | undefined;
  await refreshSessionResource(
    dispatch,
    ["ui-specs", sessionId, "namespace-seed"],
    {
      isCurrent,
      read: () => api.fetchUiSpecs(sessionId),
      apply: (specs) => {
        namespaces = collectSpecNamespaces(specs);
      },
    },
  );
  if (namespaces && isCurrent()) {
    await hydratePluginDataNamespaces(
      sessionId,
      namespaces,
      dispatch,
      isCurrent,
    );
  }
}
