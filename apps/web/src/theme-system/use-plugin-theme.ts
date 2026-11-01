import { useCallback, useSyncExternalStore } from "react";
import type { PluginThemePart } from "@covel/shared";
import { getSettings } from "@/settings/store.js";
import {
  currentPluginThemeSession,
  pluginThemeRevision,
  subscribePluginThemes,
} from "./plugin-themes.js";

/** Host use only: interactive or author-provided subtrees never receive parts. */
export function usePluginThemePart(
  sessionId: string | undefined,
  part: PluginThemePart,
) {
  const store = sessionId ? getSettings() : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      store ? subscribePluginThemes(store, listener) : () => {},
    [store],
  );
  const read = useCallback(
    () => (store ? pluginThemeRevision(store) : 0),
    [store],
  );
  useSyncExternalStore(subscribe, read, read);
  const source =
    sessionId && store
      ? currentPluginThemeSession(store, sessionId)
      : undefined;
  if (!source?.state.effective) return {};
  return {
    "data-covel-theme-scope": source.scope,
    "data-covel-theme-part": part,
  };
}

export function usePluginThemeSessionState(
  source: import("./plugin-themes.js").PluginThemeSession | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      source ? subscribePluginThemes(source.store, listener) : () => {},
    [source],
  );
  const read = useCallback(
    () => (source ? pluginThemeRevision(source.store) : 0),
    [source],
  );
  useSyncExternalStore(subscribe, read, read);
  return source?.state;
}
