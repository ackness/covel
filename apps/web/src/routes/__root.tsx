import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ToastHost } from "@/components/ui/toast-host";
import { AppErrorBoundary } from "@/components/error-boundary";
import { useLocalePreference } from "@/hooks/useLocalePreference";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { useSession } from "@/stores/session-store";

export const Route = createRootRoute({
  component: RootLayout,
});

const dragStyle: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragStyle: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties;

function RootLayout() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocalePreference();
  const location = useLocation();
  const isSession = location.pathname.startsWith('/session') || location.pathname.startsWith('/debug');
  const isHome = location.pathname === '/';

  // Carry the active session id between Studio (/session) and Debugger (/debug)
  // so flipping tabs preserves what the user is inspecting. /session has stale-
  // session logic that drops state when it loads without a sid; without this,
  // clicking Studio from /debug would always boot the user back to world-select.
  //
  // /debug doesn't restore the session into SessionProvider, so we must also
  // honour `?sid=` already in the URL. The session-store value takes priority
  // (matches the Studio's authoritative state); the URL is a read-only fallback.
  const { state: sessionState } = useSession();
  const urlSid = (() => {
    const search = location.search as unknown;
    if (typeof search === "string") {
      const v = new URLSearchParams(search).get("sid");
      return v && v.length > 0 ? v : null;
    }
    if (search && typeof search === "object") {
      const v = (search as Record<string, unknown>).sid;
      return typeof v === "string" && v.length > 0 ? v : null;
    }
    return null;
  })();
  const activeSid = sessionState.session?.id ?? urlSid;
  const navSearch = activeSid ? { sid: activeSid } : {};

  // Electron / Tauri both hide the native title bar so the in-app header can
  // follow the active theme. Electron uses `-webkit-app-region: drag`; Tauri
  // ships its own `data-tauri-drag-region` attribute. On macOS we pad-left to
  // clear the inset traffic lights.
  const ipc = getCovelIpc();
  const isElectron = ipc !== null;
  const isTauri =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
  const isMacDesktop =
    (isElectron && ipc?.platform === "darwin") ||
    (isTauri &&
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform));

  const toggleLocale = () => {
    setLocale(locale === "zh-CN" ? "en-US" : "zh-CN");
  };

  return (
    <>
      <ToastHost />
      <div className="h-screen w-full bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground flex flex-col overflow-hidden">
        <header
          className={`ui-panel-header relative flex-shrink-0 z-50 border-b border-border/80 backdrop-blur-md transition-all ${isSession ? 'h-12' : 'h-16'}`}
          style={isElectron ? dragStyle : undefined}
          data-tauri-drag-region={isTauri ? "" : undefined}
        >
          {/* Centred brand — absolutely positioned so the macOS traffic-light
              padding on the inner row doesn't shift it off centre. */}
          <Link
            to="/"
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ui-title flex items-center gap-2 tracking-tight pointer-events-auto ${isSession ? 'text-lg' : 'text-2xl'}`}
            style={isElectron ? noDragStyle : undefined}
          >
            <img
              src="/icon.png"
              alt=""
              aria-hidden="true"
              className={`rounded-md object-cover ${isSession ? 'h-6 w-6' : 'h-8 w-8'}`}
              draggable={false}
            />
            <span>Covel</span>
          </Link>

          <div
            className={`w-full flex h-full items-center justify-between ${isMacDesktop ? 'pl-[88px] pr-4 md:pr-6' : 'px-4 md:px-6'}`}
            data-tauri-drag-region={isTauri ? "" : undefined}
          >
            <nav
              className="hidden md:flex items-center gap-6 text-xs font-medium tracking-[0.14em] uppercase"
              style={isElectron ? noDragStyle : undefined}
            >
              <Link
                to="/session"
                search={navSearch}
                className="text-muted-foreground hover:text-primary transition-colors [&.active]:text-primary"
              >
                {t("nav.studio", "Studio")}
              </Link>
              <Link
                to="/debug"
                search={navSearch}
                className="text-muted-foreground hover:text-primary transition-colors [&.active]:text-primary"
              >
                {t("nav.debug", "Debugger")}
              </Link>
            </nav>
            <div
              className="flex items-center gap-1 md:gap-1.5 ml-auto"
              style={isElectron ? noDragStyle : undefined}
            >
              <ThemeToggle />
              <button
                onClick={toggleLocale}
                aria-label={locale === "zh-CN" ? "Switch to English" : "Switch to Chinese"}
                className="hidden md:flex items-center justify-center h-9 min-w-9 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary hover:bg-muted/40 transition-colors rounded-[var(--radius-control)]"
              >
                {locale === "zh-CN" ? "EN" : "中"} {/* i18n-allow: toggle shows the *other* language */}
              </button>
              {!isSession && (
                <Button
                  variant="default"
                  asChild
                  className="hidden md:flex h-9 ml-1.5 px-4 text-[11px] font-semibold uppercase tracking-widest rounded-[var(--radius-control)]"
                >
                  <Link to="/session">{t("nav.getStarted", "Get Started")}</Link>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden h-9 w-9 text-muted-foreground hover:text-primary hover:bg-muted/40 rounded-[var(--radius-control)]"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col w-full min-h-0 overflow-hidden relative">
          <AppErrorBoundary>
            <Outlet />
          </AppErrorBoundary>
        </main>

        {!isHome && <footer className={`ui-panel-footer flex-shrink-0 border-t border-border transition-all ${isSession ? 'py-1.5' : 'py-8'}`}>
          <div className={`w-full px-4 md:px-6 flex items-center justify-between ${isSession ? 'gap-2' : 'flex-col md:flex-row gap-6'}`}>
            <div className={`ui-title flex items-center gap-2 ${isSession ? 'text-xs' : 'text-base'}`}>
              <span className={`rounded-full border border-primary/45 ${isSession ? 'h-2 w-2' : 'h-3 w-3'}`}></span>
              <span>Covel Studio</span>
            </div>
            <div className={`ui-eyebrow text-muted-foreground ${isSession ? 'text-[10px]' : 'text-xs'}`}>
              &copy; {new Date().getFullYear()} Covel Framework.
            </div>
          </div>
        </footer>}
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </>
  );
}
