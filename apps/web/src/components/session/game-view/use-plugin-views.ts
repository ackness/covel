import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  pluginViewMode,
  parsePluginViewMode,
  type PluginViewMode,
} from "@covel/shared";
import {
  fetchUiSpecs,
  type SessionPlugin,
  type UISlotSpec,
} from "@/services/api.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";

export interface PluginViewEntry {
  mode: PluginViewMode;
  pluginId: string;
  viewId: string;
  label: string;
  pluginName: string;
  spec: UISlotSpec;
}
export interface PluginViews {
  reload(): void | Promise<void>;
  views: readonly PluginViewEntry[];
  status: "loading" | "ready" | "error";
}
export function usePluginViews(
  sessionId: string,
  sessionPlugins: readonly SessionPlugin[],
  language: string,
): PluginViews {
  const activePluginKey = sessionPlugins
    .filter((plugin) => plugin.active)
    .map((plugin) => plugin.id)
    .sort()
    .join("\u001f");
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    key: string;
    entries: readonly { pluginId: string; specs: UISlotSpec[] }[];
    status: PluginViews["status"];
  }>({ sessionId: "", key: "", entries: [], status: "loading" });
  const key = JSON.stringify([sessionId, activePluginKey, language]);
  const visit = useRef(key);
  visit.current = key;
  const request = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      const generation = ++request.current;
      if (!refresh)
        setLoaded((previous) => ({
          sessionId,
          key,
          entries: previous.sessionId === sessionId ? previous.entries : [],
          status: "loading",
        }));
      try {
        const response = await fetchUiSpecs(sessionId, activePluginKey);
        if (visit.current === key && request.current === generation)
          setLoaded({
            sessionId,
            key,
            entries: response.view ?? [],
            status: "ready",
          });
      } catch (error) {
        if (!refresh && visit.current === key && request.current === generation)
          setLoaded((previous) => ({ ...previous, status: "error" }));
        if (refresh) throw error;
      }
    },
    [sessionId, activePluginKey, key],
  );
  const reload = useCallback(() => load(true), [load]);
  useEffect(() => {
    void load(false);
    return () => {
      request.current++;
    };
  }, [load]);
  const views = useMemo(
    () =>
      loaded.entries.flatMap((entry) => {
        if (loaded.sessionId !== sessionId) return [];
        const plugin = sessionPlugins.find(
          (plugin) => plugin.id === entry.pluginId && plugin.active,
        );
        if (!plugin) return [];
        return entry.specs.flatMap((spec) => {
          if (
            !spec.id ||
            !parsePluginViewMode(`plugin:${entry.pluginId}:${spec.id}`)
          )
            return [];
          return [
            {
              mode: pluginViewMode(entry.pluginId, spec.id),
              pluginId: entry.pluginId,
              viewId: spec.id,
              label: resolveDisplayText(spec.label, language) || spec.id,
              pluginName:
                resolveDisplayText(plugin.displayName, language) ||
                entry.pluginId,
              spec,
            },
          ];
        });
      }),
    [loaded.entries, loaded.sessionId, sessionId, sessionPlugins, language],
  );
  return {
    views,
    reload,
    status: loaded.key === key ? loaded.status : "loading",
  };
}
