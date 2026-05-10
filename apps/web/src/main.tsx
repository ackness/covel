import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { ReloadOverlay } from "@/components/reload-overlay";
import { SessionProvider } from "@/stores/session-store";
import {
  setStorageMode,
  storageModeForServerBackend,
  storageModeForServerStorage,
  type ServerStoreBackend,
} from "@/services/data-service";
import { loadProviderKeysFromStorage } from "@/services/api";
import { probeDesktopMode } from "@/lib/desktop-bridge";
import {
  applyAppearance,
  applyColorScheme,
  DEFAULT_COLOR_SCHEME,
  type Appearance,
  type ColorScheme,
} from "@/lib/appearance";
import { getSettings, initSettings } from "@/settings/store";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
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
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const health = (await res.json()) as {
      storeBackend?: ServerStoreBackend;
      storage?: Parameters<typeof storageModeForServerStorage>[0];
    };
    const mode =
      storageModeForServerStorage(health.storage) ??
      (health.storeBackend
        ? storageModeForServerBackend(health.storeBackend)
        : null);
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
  await store.set(THEME_SCHEME_KEY, scheme);
  window.localStorage.removeItem("theme");
}

function syncNextThemesStorage(scheme: ColorScheme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("covel:scheme", scheme);
}

// Boot order: hydrate settings store first so appearance / locale apply
// without a flash, then run the rest of the bootstrap in parallel.
initSettings()
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
    store.subscribe<SupportedLocale>("ui.locale", (next) => {
      if (i18n.language !== next) void i18n.changeLanguage(next);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next;
      }
    });
    return Promise.all([
      syncStorageMode(),
      probeDesktopMode(),
      loadProviderKeysFromStorage(),
    ]);
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
