import { useCallback, useSyncExternalStore } from "react";
import type { SettingKey, SettingsStoreApi } from "@covel/settings";
import { getSettings } from "./store.js";

/**
 * Read one setting reactively. Writes go through `set` (async; the return
 * value auto-updates once the store persists).
 */
export function useSetting<T>(
  key: SettingKey,
): [T, (value: T) => Promise<void>] {
  const store = getSettings();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(key, () => notify()),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.get<T>(key), [store, key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback(
    async (next: T) => store.set<T>(key, next),
    [store, key],
  );
  return [value, setValue];
}

/** Access the store imperatively (e.g. for import/export, bulk ops). */
export function useSettingsStore(): SettingsStoreApi {
  return getSettings();
}
