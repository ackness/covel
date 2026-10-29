import { useCallback, useEffect, useMemo, useState } from "react";
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
  reload(): void;
  views: readonly PluginViewEntry[];
  status: "loading" | "ready" | "error";
}
export function usePluginViews(
  sessionId: string,
  sessionPlugins: readonly SessionPlugin[],
  language: string,
): PluginViews {
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const activePluginKey = sessionPlugins
    .filter((plugin) => plugin.active)
    .map((plugin) => plugin.id)
    .sort()
    .join("\u001f");
  const [loaded, setLoaded] = useState<{
    key: string;
    entries: readonly { pluginId: string; specs: UISlotSpec[] }[];
    status: PluginViews["status"];
  }>({ key: "", entries: [], status: "loading" });
  const key = JSON.stringify([sessionId, activePluginKey, language, revision]);
  useEffect(() => {
    let cancelled = false;
    setLoaded((previous) => ({ ...previous, key, status: "loading" }));
    fetchUiSpecs(sessionId, activePluginKey)
      .then((response) => {
        if (!cancelled)
          setLoaded({ key, entries: response.view ?? [], status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, entries: [], status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, activePluginKey, language, key]);
  const views = useMemo(
    () =>
      loaded.entries.flatMap((entry) => {
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
    [loaded.entries, sessionPlugins, language],
  );
  return {
    views,
    reload,
    status: loaded.key === key ? loaded.status : "loading",
  };
}
