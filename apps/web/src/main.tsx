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
import { fetchServerHealth } from "@/services/api";
import { probeDesktopMode } from "@/lib/desktop-bridge";
import {
  applyAppearance,
  applyColorScheme,
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
import i18n, { i18nReady } from "@/i18n";
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

function syncNextThemesStorage(scheme: ColorScheme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("covel:scheme", scheme);
}

const root = createRoot(document.getElementById("root")!);
let booting = false;

function renderApp(): void {
  root.render(
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
}

function renderBootError(message: string): void {
  root.render(
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 border border-border p-6">
        <h1 className="text-sm font-medium text-destructive">
          {i18n.t("error.boot.title")}
        </h1>
        <p className="text-xs text-muted-foreground">{message}</p>
        <button
          type="button"
          onClick={() => void boot()}
          className="border border-primary bg-primary px-3 py-2 text-xs uppercase tracking-widest text-primary-foreground hover:bg-primary/90"
        >
          {i18n.t("error.boot.retry")}
        </button>
      </div>
    </div>,
  );
}

// The settings adapter is fixed when its store is created. An inconclusive
// mode probe must leave that store untouched so a later retry can still pick
// the correct backend instead of silently writing desktop settings locally.
async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    try {
      await i18nReady;
    } catch (err) {
      console.error("[boot] locale catalog failed:", err);
    }
    if ((await probeDesktopMode()) === "unknown") {
      renderBootError(i18n.t("error.boot.desktopModeUnavailable"));
      return;
    }
    try {
      await initSettings();
      const store = getSettings();
      syncThemeRegistry(store);
      // Apply initial appearance / locale ASAP so the first paint matches.
      applyAppearance(store.get<Appearance>("ui.appearance"));
      const initialScheme = store.get<ColorScheme>(THEME_SCHEME_KEY);
      applyColorScheme(initialScheme);
      syncNextThemesStorage(initialScheme);
      const initialLocale = store.get<SupportedLocale>("ui.locale");
      if (i18n.language !== initialLocale) {
        await i18n.changeLanguage(initialLocale);
      }
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
      await syncStorageMode();
    } catch (err) {
      // Hydration concerns must not leave the page blank after the backend is
      // known. SettingsStore rejects writes if hydration itself failed.
      console.error(
        "[boot] bootstrap step failed — continuing on defaults:",
        err,
      );
    }
    renderApp();
  } catch (err) {
    console.error("[boot] startup failed:", err);
    renderBootError(i18n.t("error.boundary.appDescription"));
  } finally {
    booting = false;
  }
}

void boot();
