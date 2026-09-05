import {
  createJsonFileBackend,
  createLocalStorageBackend,
  SettingsStore,
  SettingsRevisionConflictError,
} from "@covel/settings";
import type { SettingsStoreApi } from "@covel/settings";
import {
  registerCoreSettings,
  registerLlmSettings,
  registerProviderKeys,
} from "./registry/index.js";
import i18n from "i18next";
import { getDesktopRestAuthHeaders, isDesktopApp } from "@/lib/desktop-bridge";
import { emitToast } from "@/lib/toast-channel";
import { synchronizeSettings } from "./synchronize-settings.js";
import { resolveSettingEntryText } from "./framework-i18n.js";

let singleton: SettingsStore | null = null;
let readyPromise: Promise<void> | null = null;

function createStore(): SettingsStore {
  // isDesktopApp() covers BOTH desktop signals: the Electron IPC bridge and
  // the REST-desktop probe (`/api/config/info` → isDesktop, self-host setups
  // where the sidecar owns ~/.covel). The boot sequence in main.tsx runs
  // probeDesktopMode() BEFORE initSettings() so this decision sees the probe
  // result; without that ordering REST-desktop silently fell back to
  // localStorage and settings never reached ~/.covel/settings.json.
  const adapter = isDesktopApp()
    ? createJsonFileBackend({ getAuthHeaders: getDesktopRestAuthHeaders })
    : createLocalStorageBackend();
  const store = new SettingsStore(adapter);
  registerCoreSettings(store);
  registerLlmSettings(store);
  // Store observes rejected persistence promises itself so existing `void
  // store.set()` calls cannot leak unhandled rejections. Surface only CAS
  // conflicts here; other validation/read-only errors are already represented
  // by their owning UI paths and would otherwise duplicate toasts.
  store.subscribePersistenceErrors((error) => {
    if (error instanceof SettingsRevisionConflictError) {
      const entries = store.listEntries();
      const labels = error.conflictingKeys.map((key) => {
        const entry = entries.find((item) => item.key === key);
        return entry
          ? resolveSettingEntryText(entry, "label", i18n.language)
          : key;
      });
      emitToast(
        "error",
        i18n.t("settings.conflictTitle", {
          defaultValue: "Settings changed in another window",
        }) as string,
        i18n.t("settings.conflictDetail", {
          keys: labels.join(", ") || i18n.t("settings.title"),
          defaultValue:
            "{{keys}} was not saved. The latest saved values have been loaded. Review them and retry your change.",
        }) as string,
      );
    }
  });
  return store;
}

/** Accessor — lazily creates the singleton. */
export function getSettings(): SettingsStoreApi {
  if (!singleton) {
    singleton = createStore();
  }
  return singleton;
}

/**
 * Hydrate the settings store from disk/localStorage. Must be awaited once at
 * app boot before the first render that consumes a setting. Idempotent.
 */
export function initSettings(): Promise<void> {
  if (!readyPromise) {
    const store = getSettings() as SettingsStore;
    readyPromise = store.init().then(() => {
      synchronizeSettings(store);
    });
  }
  return readyPromise;
}

/**
 * Register known providers discovered from llm.toml so the Settings UI can
 * render a per-provider secret input. Can be called multiple times — the
 * registry overwrites by key.
 */
export function registerKnownProviders(ids: readonly string[]): void {
  registerProviderKeys(getSettings(), ids);
}
