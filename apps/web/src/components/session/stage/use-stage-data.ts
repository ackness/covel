import { useEffect, useMemo, useState } from "react";
import { listPluginData } from "@/services/api/plugin-data.js";
import {
  usePluginNamespace,
  type PluginData,
} from "@/stores/plugin-data-store.js";

const EMPTY_DATA: PluginData = {};
const EMPTY_NAMESPACE: Readonly<Record<string, unknown>> = {};

/** A mobile stage has no mounted sidebar to hydrate plugin data for it.
 * Keep its initial read local: live SSE data always wins over an older fetch. */
export function useStageData(
  sessionId: string,
  pluginIds: readonly string[],
): PluginData {
  const providersKey = [...new Set(pluginIds.filter(Boolean))]
    .sort()
    .join("\n");
  const key = `${sessionId}\n${providersKey}`;
  const [loaded, setLoaded] = useState<{ key: string; data: PluginData }>();

  useEffect(() => {
    if (!providersKey) return;
    let cancelled = false;
    void Promise.all(
      providersKey.split("\n").map(async (pluginId) => {
        const rows = await listPluginData(sessionId, pluginId);
        const namespaces: PluginData[string] = {};
        for (const row of rows) {
          (namespaces[row.namespace] ??= {})[row.key] = row.value;
        }
        return [pluginId, namespaces] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setLoaded({ key, data: Object.fromEntries(entries) });
      })
      .catch((error: unknown) => {
        console.warn("[stage] initial data fetch failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, providersKey, key]);

  return loaded?.key === key ? loaded.data : EMPTY_DATA;
}

export function useStageNamespace(
  initialData: PluginData,
  pluginId: string,
  namespace: string,
): Readonly<Record<string, unknown>> {
  const live = usePluginNamespace(pluginId, namespace);
  const initial = initialData[pluginId]?.[namespace] ?? EMPTY_NAMESPACE;
  return useMemo(() => ({ ...initial, ...live }), [initial, live]);
}
