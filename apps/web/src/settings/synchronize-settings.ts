import {
  LOCAL_STORAGE_SETTINGS_KEY,
  type SettingsStoreApi,
} from "@covel/settings";

/** Refresh preferences only; API keys use their independent secret channel. */
export function synchronizeSettings(
  store: SettingsStoreApi,
  target = window,
): () => void {
  let refreshing = false;
  let rerun = false;
  let stopped = false;
  const refresh = async () => {
    if (stopped || !store.isHydrated()) return;
    if (refreshing) {
      rerun = true;
      return;
    }
    refreshing = true;
    try {
      await store.refresh();
    } catch {
      // A failed read never replaces the last confirmed snapshot. The next
      // focus/storage event retries; writes still retain their CAS protection.
    } finally {
      refreshing = false;
      if (rerun) {
        rerun = false;
        void refresh();
      }
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_STORAGE_SETTINGS_KEY) void refresh();
  };
  const onVisibility = () => {
    if (target.document.visibilityState === "visible") void refresh();
  };
  target.addEventListener("storage", onStorage);
  target.addEventListener("focus", refresh);
  target.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    target.removeEventListener("storage", onStorage);
    target.removeEventListener("focus", refresh);
    target.document.removeEventListener("visibilitychange", onVisibility);
  };
}
