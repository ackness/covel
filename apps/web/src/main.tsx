import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/stores/session-store";
import { setStorageMode } from "@/services/data-service";
import { loadProviderKeysFromStorage } from "@/services/api";
import { probeDesktopMode } from "@/lib/desktop-bridge";
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

Promise.all([
  syncStorageMode(),
  probeDesktopMode(),
  loadProviderKeysFromStorage(),
]).then(() => {
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
