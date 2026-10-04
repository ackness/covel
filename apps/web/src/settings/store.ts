import {
  createJsonFileBackend,
  createLocalStorageBackend,
  SettingsStore,
  SettingsRevisionConflictError,
} from "@covel/settings";
import type { SettingsBackendAdapter, SettingsStoreApi } from "@covel/settings";
import {
  registerCoreSettings,
  registerLlmSettings,
  registerProviderKeys,
} from "./registry/index.js";
import i18n from "i18next";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { emitToast } from "@/lib/toast-channel";
import { synchronizeSettings } from "./synchronize-settings.js";
import { resolveSettingEntryText } from "./framework-i18n.js";

let singleton: SettingsStore | null = null;
let readyPromise: Promise<void> | null = null;
let backend: SettingsBackendAdapter | null = null;

/**
 * Settings from an earlier version that this version could not keep. Either
 * the whole stored bundle was moved aside (`keys` is absent and every setting
 * starts from its default), or the listed keys were dropped from it. `backup`
 * names the copy of what was stored.
 */
export interface SettingsBackupNotice {
  readonly backup: string;
  readonly keys?: readonly string[];
}

// Most notices arise during boot, before anything can show them. They wait
// here until the app shell asks for them.
const pendingNotices: SettingsBackupNotice[] = [];
let showNotice: ((notice: SettingsBackupNotice) => void) | null = null;

function publishNotice(notice: SettingsBackupNotice): void {
  if (showNotice) showNotice(notice);
  else pendingNotices.push(notice);
}

/** Receive the waiting notices, and each later one. Returns the unsubscribe. */
export function receiveSettingsBackupNotices(
  handler: (notice: SettingsBackupNotice) => void,
): () => void {
  showNotice = handler;
  for (const notice of pendingNotices.splice(0)) handler(notice);
  return () => {
    if (showNotice === handler) showNotice = null;
  };
}

/** The labels of settings, in the interface language, for a message. */
export function settingLabels(keys: readonly string[]): string {
  const entries = getSettings().listEntries();
  return keys
    .map((key) => {
      const entry = entries.find((item) => item.key === key);
      return entry
        ? resolveSettingEntryText(entry, "label", i18n.language)
        : key;
    })
    .join(", ");
}

function createStore(): SettingsStore {
  // Personal preferences and BYOK belong to this browser/device. A server's
  // home directory does not grant it ownership of browser settings.
  const ipc = getCovelIpc();
  const adapter = ipc
    ? createJsonFileBackend({ ipc })
    : createLocalStorageBackend();
  backend = adapter;
  const store = new SettingsStore(adapter);
  registerCoreSettings(store);
  registerLlmSettings(store);
  // Store observes rejected persistence promises itself so existing `void
  // store.set()` calls cannot leak unhandled rejections. Surface only CAS
  // conflicts here; other validation/read-only errors are already represented
  // by their owning UI paths and would otherwise duplicate toasts.
  store.subscribePersistenceErrors((error) => {
    if (error instanceof SettingsRevisionConflictError) {
      emitToast(
        "error",
        i18n.t("settings.conflictTitle", {
          defaultValue: "Settings changed in another window",
        }) as string,
        i18n.t("settings.conflictDetail", {
          keys:
            settingLabels(error.conflictingKeys) || i18n.t("settings.title"),
          defaultValue:
            "{{keys}} was not saved. The latest saved values have been loaded. Review them and retry your change.",
        }) as string,
      );
    }
  });
  store.subscribeRepairs(publishNotice);
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
    readyPromise = store.init().then(async () => {
      synchronizeSettings(store);
      const archived = await backend?.takeArchivedBundle?.().catch(() => null);
      if (archived) publishNotice({ backup: archived });
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
