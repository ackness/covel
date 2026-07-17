import {
  createJsonFileBackend,
  createLocalStorageBackend,
  SettingsStore,
} from "@covel/settings";
import type { SettingsStoreApi } from "@covel/settings";
import {
  registerCoreSettings,
  registerLlmSettings,
  registerProviderKeys,
} from "./registry/index.js";
import { cleanupLegacyLocalStorage } from "./legacy-cleanup.js";
import { getDesktopRestAuthHeaders, isDesktopApp } from "@/lib/desktop-bridge";

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
    cleanupLegacyLocalStorage();
    const store = getSettings() as SettingsStore;
    readyPromise = store.init();
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
