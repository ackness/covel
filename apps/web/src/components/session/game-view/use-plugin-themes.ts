import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MAX_PLUGIN_THEMES,
  resolvedPluginThemeEntrySchema,
} from "@covel/shared";
import { useSettingsStore } from "@/settings/use-settings.js";
import { fetchUiSpecs, type SessionPlugin } from "@/services/api.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  PluginThemeSession,
  subscribePluginThemes,
  pluginThemeRevision,
} from "@/theme-system/plugin-themes.js";

let requestSequence = 0;

export function usePluginThemes(
  sessionId: string,
  plugins: readonly SessionPlugin[],
  language: string,
) {
  const store = useSettingsStore();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    source: PluginThemeSession;
  }>();
  const activeKey = JSON.stringify(
    plugins
      .filter((plugin) => plugin.active)
      .map((plugin) => [plugin.id, plugin.version, plugin.displayName])
      .sort(),
  );
  const key = JSON.stringify([sessionId, activeKey, language, revision]);
  const active = useMemo(
    () => plugins.filter((plugin) => plugin.active),
    [activeKey],
  );
  const subscribe = useCallback(
    (listener: () => void) => subscribePluginThemes(store, listener),
    [store],
  );
  const read = useCallback(() => pluginThemeRevision(store), [store]);
  useSyncExternalStore(subscribe, read, read);
  useLayoutEffect(() => {
    const source = new PluginThemeSession(store, sessionId);
    setLoaded({ sessionId, source });
    return () => source.dispose();
  }, [store, sessionId]);
  useLayoutEffect(() => {
    const source = loaded?.sessionId === sessionId ? loaded.source : undefined;
    if (!source) return;
    source.replace([], "loading");
    let cancelled = false;
    void fetchUiSpecs(sessionId, JSON.stringify([key, ++requestSequence]))
      .then((response) => {
        if (cancelled) return;
        if (!Array.isArray(response.theme)) {
          source.replace([], "error");
          return;
        }
        const packs = response.theme.flatMap((entry) => {
          if (
            !entry ||
            !Array.isArray(entry.specs) ||
            entry.specs.length > MAX_PLUGIN_THEMES
          )
            return [];
          const owner = active.find((plugin) => plugin.id === entry.pluginId);
          if (!owner) return [];
          return entry.specs.flatMap((spec) => {
            const parsed = resolvedPluginThemeEntrySchema.safeParse({
              pluginId: entry.pluginId,
              specs: [spec],
            });
            return parsed.success
              ? parsed.data.specs.map((theme) => ({
                  theme,
                  owner:
                    resolveDisplayText(owner.displayName, language) || owner.id,
                }))
              : [];
          });
        });
        source.replace(packs, "ready");
      })
      .catch(() => {
        if (!cancelled) source.replace([], "error");
      });
    return () => {
      cancelled = true;
      source.replace([], "loading");
    };
    // `active` follows `activeKey`, not the list's identity: a plugin list
    // reloaded with the same activations must not drop and refetch the theme
    // (every themed Markdown body would re-render twice).
  }, [loaded, sessionId, key, active, language]);
  return {
    source: loaded?.sessionId === sessionId ? loaded.source : undefined,
    reload: () => setRevision((value) => value + 1),
  };
}
