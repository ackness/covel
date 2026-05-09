import * as api from "@/services/api";
import {
  loadPluginData,
  type PluginDataChange,
} from "@/stores/plugin-data-store.js";
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

export async function hydratePluginDataNamespaces(
  sessionId: string,
  namespaces: readonly PluginNamespace[],
  dispatch: SessionDispatch,
): Promise<void> {
  await Promise.all(
    namespaces.map(async ({ pluginId, namespace }) => {
      const rows = await api.listPluginData(sessionId, pluginId, namespace);
      if (rows.length === 0) return;

      loadPluginData(
        pluginId,
        namespace,
        rows.map((row) => ({ key: row.key, value: row.value })),
      );

      const changes: PluginDataChange[] = rows.map((row) => ({
        namespace,
        key: row.key,
        value: row.value,
        operation: "set",
      }));
      dispatch({ type: "PLUGIN_DATA_CHANGED", pluginId, changes });
    }),
  );
}

export async function hydratePluginDataForUiSpecs(
  sessionId: string,
  dispatch: SessionDispatch,
): Promise<void> {
  const specs = await api.fetchUiSpecs(sessionId);
  await hydratePluginDataNamespaces(
    sessionId,
    collectSpecNamespaces(specs),
    dispatch,
  );
}
