import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { ReloadOverlay } from "@/components/reload-overlay";
import { SessionProvider } from "@/stores/session-store";
import {
  setStorageMode,
  storageModeForServerStorage,
} from "@/services/data-service";
import { fetchServerHealth, loadProviderKeysFromStorage } from "@/services/api";
import { probeDesktopMode } from "@/lib/desktop-bridge";
import {
  applyAppearance,
  applyColorScheme,
  DEFAULT_COLOR_SCHEME,
  type Appearance,
  type ColorScheme,
} from "@/lib/appearance";
import { getSettings, initSettings } from "@/settings/store";
import { configureMessagesWindowCap } from "@/stores/session-store/reducer";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import {
  APPEARANCE_TOKENS_KEY,
  applyTokenOverrides,
} from "@/theme-system/overrides.js";
import {
  syncThemeRegistry,
  THEME_SCHEME_KEY,
} from "@/theme-system/registry.js";
import i18n from "@/i18n";
import type { SupportedLocale } from "@/i18n/locale-detector";
import "@/i18n";
import "@/index.css";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * Detect server storage backend and set frontend storage mode accordingly.
 * storage.data.frontendMode=remote → RemoteDataService (server @covel/store)
 * storage.data.frontendMode=local  → LocalDataService (browser IDB)
 */
async function syncStorageMode(): Promise<void> {
  try {
    // Shared helper rather than a second hand-rolled health fetch: it checks
    // the status, rejects a non-JSON body, and carries a timeout so a wedged
    // proxy can't hold first paint on a blank page.
    const health = await fetchServerHealth();
    const mode = storageModeForServerStorage(
      health.storage as Parameters<typeof storageModeForServerStorage>[0],
    );
    if (mode) {
      setStorageMode(mode);
    }
  } catch {
    // server unreachable — keep current mode
  }
}

async function migrateLegacyThemeScheme(store: ReturnType<typeof getSettings>) {
  if (store.has(THEME_SCHEME_KEY) || typeof window === "undefined") return;
  const legacyTheme =
    window.localStorage.getItem("covel:scheme") ??
    window.localStorage.getItem("theme");
  const scheme =
    legacyTheme === "light" || legacyTheme === "dark"
      ? legacyTheme
      : DEFAULT_COLOR_SCHEME;
  try {
    await store.set(THEME_SCHEME_KEY, scheme);
    window.localStorage.removeItem("theme");
  } catch (err) {
    // A read-only store (failed hydration) must not stop the app from booting;
    // the migration retries on the next launch. Keep the legacy key so nothing
    // is lost while writes are refused.
    console.warn("[boot] theme-scheme migration skipped:", err);
  }
}

function syncNextThemesStorage(scheme: ColorScheme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("covel:scheme", scheme);
}

// Boot order: probe desktop mode FIRST — the settings backend choice
// (localStorage vs ~/.covel via IPC/REST) depends on its result — then
// hydrate the settings store so appearance / locale apply without a flash,
// then run the rest of the bootstrap in parallel. The probe is one same-origin
// fetch (skipped entirely under Electron IPC) and non-fatal on failure.
probeDesktopMode()
  .then(() => initSettings())
  .then(async () => {
    const store = getSettings();
    await migrateLegacyThemeScheme(store);
    syncThemeRegistry(store);
    // Apply initial appearance / locale ASAP so the first paint matches.
    applyAppearance(store.get<Appearance>("ui.appearance"));
    const initialScheme = store.get<ColorScheme>(THEME_SCHEME_KEY);
    applyColorScheme(initialScheme);
    syncNextThemesStorage(initialScheme);
    const initialLocale = store.get<SupportedLocale>("ui.locale");
    if (i18n.language !== initialLocale)
      void i18n.changeLanguage(initialLocale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = initialLocale;
    }
    // Global subscribers so changes from the Settings UI propagate even when
    // no component is currently mounted that reads the underlying setting.
    store.subscribe<Appearance>("ui.appearance", (next) => {
      applyAppearance(next);
      syncThemeRegistry(store);
    });
    store.subscribe<ColorScheme>(THEME_SCHEME_KEY, (next) => {
      applyColorScheme(next);
      syncNextThemesStorage(next);
      syncThemeRegistry(store);
    });
    store.subscribe(CUSTOM_THEMES_KEY, () => {
      syncThemeRegistry(store);
    });
    store.subscribe(APPEARANCE_TOKENS_KEY, () => {
      applyTokenOverrides(store);
    });
    store.subscribe<SupportedLocale>("ui.locale", (next) => {
      if (i18n.language !== next) void i18n.changeLanguage(next);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next;
      }
    });
    configureMessagesWindowCap(store.get<number>("ui.chatMessageWindow"));
    store.subscribe<number>("ui.chatMessageWindow", (next) => {
      configureMessagesWindowCap(next);
    });
    return Promise.all([syncStorageMode(), loadProviderKeysFromStorage()]);
  })
  // Nothing in the bootstrap is allowed to stop the app from mounting. Every
  // step above is a preference/hydration concern; a rejection here used to
  // leave `createRoot` unreached and the page permanently blank, which is
  // strictly worse than booting on defaults.
  .catch((err: unknown) => {
    console.error(
      "[boot] bootstrap step failed — continuing on defaults:",
      err,
    );
  })
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ThemeProvider
          defaultTheme={getSettings().get<ColorScheme>(THEME_SCHEME_KEY)}
          enableSystem={false}
          storageKey="covel:scheme"
          attribute="class"
        >
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
          <ReloadOverlay />
        </ThemeProvider>
      </StrictMode>,
    );
  });
