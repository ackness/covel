import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/stores/session-store";
import { setStorageMode } from "@/services/data-service";
import { loadProviderKeysFromStorage } from "@/services/api";
import { probeDesktopMode } from "@/lib/desktop-bridge";
import { applyAppearance, type Appearance } from "@/lib/appearance";
import { getSettings, initSettings } from "@/settings/store";
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
 * STORE_BACKEND=pg  → RemoteDataService (all data on server via @covel/store PgStore)
 * STORE_BACKEND=memory → LocalDataService (session data in browser IDB)
 */
async function syncStorageMode(): Promise<void> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const health = await res.json() as { storeBackend?: string };
    // Any server-side persistent backend → use remote DataService so reads
    // hit the server's authoritative store. Only the ephemeral in-memory
    // backend falls back to the browser's IDB (no server persistence).
    if (health.storeBackend === "pg" || health.storeBackend === "sqlite") {
      setStorageMode("remote");
    }
  } catch {
    // server unreachable — keep current mode
  }
}

// Boot order: hydrate settings store first so appearance / locale apply
// without a flash, then run the rest of the bootstrap in parallel.
initSettings()
  .then(() => {
    const store = getSettings();
    // Apply initial appearance / locale ASAP so the first paint matches.
    applyAppearance(store.get<Appearance>("ui.appearance"));
    const initialLocale = store.get<SupportedLocale>("ui.locale");
    if (i18n.language !== initialLocale) void i18n.changeLanguage(initialLocale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = initialLocale;
    }
    // Global subscribers so changes from the Settings UI propagate even when
    // no component is currently mounted that reads the underlying setting.
    store.subscribe<Appearance>("ui.appearance", (next) => {
      applyAppearance(next);
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
        <ThemeProvider defaultTheme="dark" attribute="class">
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  });
