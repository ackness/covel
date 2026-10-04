import i18n from "i18next";
import { useCallback, useSyncExternalStore } from "react";
import {
  SettingsRevisionConflictError,
  type SettingKey,
  type SettingsStoreApi,
} from "@covel/settings";
import { emitToast } from "@/lib/toast-channel.js";
import { getSettings } from "./store.js";

/**
 * Read one setting reactively. Writes go through `set` (async; the return
 * value auto-updates once the store persists).
 *
 * Every widget call site is fire-and-forget (`void setValue(...)`), so a
 * rejected write would otherwise be invisible: the field keeps showing the
 * typed value while storage still holds the old one. Surface it here — one
 * chokepoint covers every widget.
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
    async (next: T) => {
      try {
        await store.set<T>(key, next);
      } catch (err) {
        // The store-level listener owns CAS conflicts so imperative
        // fire-and-forget writes and widget writes share one notification.
        if (err instanceof SettingsRevisionConflictError) return;
        emitToast(
          "error",
          i18n.t("settings.saveFailed", {
            defaultValue: "Could not save setting",
          }) as string,
          err instanceof Error ? err.message : String(err),
        );
        // Deliberately not rethrown: every call site is `void setValue(...)`,
        // so rethrowing would only produce an unhandled rejection. The toast
        // is the handling.
      }
    },
    [store, key],
  );
  return [value, setValue];
}

/**
 * Whether the player set this key, and a way to drop that value. A cleared
 * key reads its default again, and a plugin setting follows the world again.
 */
export function useSettingOverride(
  key: SettingKey,
): [boolean, () => Promise<void>] {
  const store = getSettings();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(key, () => notify()),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.has(key), [store, key]);
  const overridden = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const restoreDefault = useCallback(async () => {
    try {
      await store.clear(key);
    } catch (err) {
      if (err instanceof SettingsRevisionConflictError) return;
      emitToast(
        "error",
        i18n.t("settings.saveFailed", {
          defaultValue: "Could not save setting",
        }) as string,
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [store, key]);
  return [overridden, restoreDefault];
}

/** Access the store imperatively (e.g. for import/export, bulk ops). */
export function useSettingsStore(): SettingsStoreApi {
  return getSettings();
}
