import {
  createJsonFileBackend,
  createLocalStorageBackend,
  SettingsStore,
} from "@covel/shared";
import type { SettingsStoreApi } from "@covel/shared";
import {
  registerCoreSettings,
  registerLlmSettings,
  registerProviderKeys,
} from "./registry/index.js";
import { cleanupLegacyLocalStorage } from "./legacy-cleanup.js";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge";

function isDesktopBridge(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { covelIpc?: unknown }).covelIpc);
}

let singleton: SettingsStore | null = null;
let readyPromise: Promise<void> | null = null;

function createStore(): SettingsStore {
  const adapter = isDesktopBridge()
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
