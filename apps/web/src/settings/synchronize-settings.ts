import {
  LOCAL_STORAGE_SETTINGS_KEY,
  LOCAL_STORAGE_KEYS_KEY,
  type SettingsStoreApi,
} from "@covel/settings";

/** Invalidate independent caches without copying secret values into revisions. */
export function synchronizeSettings(
  store: SettingsStoreApi,
  target = window,
): () => void {
  const refreshing = { values: false, secrets: false, server: false };
  const rerun = { values: false, secrets: false, server: false };
  let stopped = false;
  const refresh = async (channel: "values" | "secrets" | "server") => {
    // The server's settings do not depend on what this device could read.
    if (stopped || (channel !== "server" && !store.isHydrated())) return;
    if (refreshing[channel]) {
      rerun[channel] = true;
      return;
    }
    refreshing[channel] = true;
    try {
      if (channel === "values") await store.refresh();
      else if (channel === "secrets") await store.refreshSecrets();
      else await store.refreshServerSettings();
    } catch {
      // A failed read never replaces the last confirmed snapshot. The next
      // focus/storage event retries; writes still retain their CAS protection.
    } finally {
      refreshing[channel] = false;
      if (rerun[channel]) {
        rerun[channel] = false;
        void refresh(channel);
      }
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_STORAGE_SETTINGS_KEY || event.key === null)
      void refresh("values");
    if (event.key === LOCAL_STORAGE_KEYS_KEY || event.key === null)
      void refresh("secrets");
  };
  const onFocus = () => {
    void refresh("values");
    void refresh("secrets");
    // Another browser of the same install may have changed one.
    void refresh("server");
  };
  const onVisibility = () => {
    if (target.document.visibilityState === "visible") onFocus();
  };
  target.addEventListener("storage", onStorage);
  target.addEventListener("focus", onFocus);
  target.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    target.removeEventListener("storage", onStorage);
    target.removeEventListener("focus", onFocus);
    target.document.removeEventListener("visibilitychange", onVisibility);
  };
}
