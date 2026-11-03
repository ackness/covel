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
  // The snapshot is the scope itself, not the registry revision: a refresh
  // that leaves this session's effective theme alone must not re-render (and
  // re-parse) every Markdown body on the page.
  const read = useCallback(() => {
    if (!sessionId || !store) return "";
    const source = currentPluginThemeSession(store, sessionId);
    return source?.state.effective ? source.scope : "";
  }, [store, sessionId]);
  const scope = useSyncExternalStore(subscribe, read, read);
  if (!scope) return {};
  return {
    "data-covel-theme-scope": scope,
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
