import {
  createRootRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { ToastHost } from "@/components/ui/toast-host";
import { ConfirmHost } from "@/components/ui/confirm-host";
import { AppErrorBoundary } from "@/components/error-boundary";
import { useLocalePreference } from "@/hooks/useLocalePreference";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { useSession } from "@/stores/session-store";
import { emitNavEvent } from "@/lib/nav-events";

export const Route = createRootRoute({
  component: RootLayout,
});

const dragStyle: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragStyle: CSSProperties = {
  WebkitAppRegion: "no-drag",
} as CSSProperties;

function RootLayout() {
  const { t } = useTranslation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { locale, setLocale } = useLocalePreference();
  const location = useLocation();
  const navigate = useNavigate();
  const isSessionRoute = location.pathname.startsWith("/session");
  const isDebugRoute = location.pathname.startsWith("/debug");
  const isSession = isSessionRoute || isDebugRoute;
  const isHome = location.pathname === "/";
  const showRouterDevtools = !isSessionRoute && !isDebugRoute;

  // Carry the active session id between Studio (/session) and Debugger (/debug)
  // so flipping tabs preserves what the user is inspecting. /session has stale-
  // session logic that drops state when it loads without a sid; without this,
  // clicking Studio from /debug would always boot the user back to world-select.
  //
  // /debug doesn't restore the session into SessionProvider, so we must also
  // honour `?sid=` already in the URL. The session-store value takes priority
  // (matches the Studio's authoritative state); the URL is a read-only fallback.
  const { state: sessionState, backToWorldSelect } = useSession();
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
  const hasSession = sessionState.session !== null;
  const sessionSearch = activeSid ? { sid: activeSid } : {};

  // Active state for the primary nav. The 5 tabs map to either real routes
  // (世界 / 会话 / 调试) or in-page panel toggles (插件 / 图像) so the active
  // computation has to merge URL state with sub-views.
  type NavId = "world" | "session" | "plugins" | "images" | "debug";
  const activeNav: NavId | null = (() => {
    if (isDebugRoute) return "debug";
    if (isSessionRoute) {
      // World-select view (no session) implicitly maps to 世界
      if (!hasSession) return "world";
      return "session";
    }
    return null;
  })();

  const goWorld = () => {
    if (sessionState.session) backToWorldSelect();
    navigate({ to: "/session", search: {} });
  };
  const goSession = () => navigate({ to: "/session", search: sessionSearch });
  const goPlugins = () => {
    navigate({ to: "/session", search: sessionSearch });
    emitNavEvent("open-plugins");
  };
  const goImages = () => {
    navigate({ to: "/session", search: sessionSearch });
    emitNavEvent("open-images");
  };
  const goDebug = () => navigate({ to: "/debug", search: navSearch });

  const navItems: Array<{
    id: NavId;
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }> = [
    { id: "world", label: t("nav.world"), onClick: goWorld },
    {
      id: "session",
      label: t("nav.session"),
      onClick: goSession,
      disabled: !hasSession,
    },
    {
      id: "plugins",
      label: t("nav.plugins"),
      onClick: goPlugins,
      disabled: !hasSession,
    },
    {
      id: "images",
      label: t("nav.images"),
      onClick: goImages,
      disabled: !hasSession,
    },
    { id: "debug", label: t("nav.debug"), onClick: goDebug },
  ];

  // Electron hides the native title bar so the in-app header can follow the
  // active theme. On macOS we pad-left to clear the inset traffic lights.
  const ipc = getCovelIpc();
  const isElectron = ipc !== null;
  const isMacDesktop = isElectron && ipc?.platform === "darwin";

  const toggleLocale = () => {
    setLocale(locale === "zh-CN" ? "en-US" : "zh-CN");
  };

  return (
    <>
      <ToastHost />
      <ConfirmHost />
      <div className="h-screen w-full bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground flex flex-col overflow-hidden">
        <header
          className={`ui-panel-header relative shrink-0 z-50 border-b border-border/80 backdrop-blur-md transition-all ${isSession ? "h-12" : "h-16"}`}
          style={isElectron ? dragStyle : undefined}
        >
          {/* Centred brand — absolutely positioned so the macOS traffic-light
              padding on the inner row doesn't shift it off centre. */}
          <Link
            to="/"
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ui-title flex items-center gap-2 tracking-tight pointer-events-auto ${isSession ? "text-lg" : "text-2xl"}`}
            style={isElectron ? noDragStyle : undefined}
          >
            <img
              src="/icon.png"
              alt=""
              aria-hidden="true"
              className={`rounded-md object-cover ${isSession ? "h-6 w-6" : "h-8 w-8"}`}
              draggable={false}
            />
            <span>Covel</span>
          </Link>

          <div
            className={`w-full flex h-full items-center justify-between ${isMacDesktop ? "pl-22 pr-4 md:pr-6" : "px-4 md:px-6"}`}
          >
            <nav
              className="hidden md:flex items-center gap-1 text-xs font-medium"
              style={isElectron ? noDragStyle : undefined}
              aria-label={t("nav.primary", "Primary")}
            >
              {navItems.map((item) => {
                const isActive = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.onClick}
                    disabled={item.disabled}
                    aria-current={isActive ? "page" : undefined}
                    className={`relative h-8 px-3 transition-colors rounded-(--radius-control) ${
                      isActive
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    } ${
                      item.disabled
                        ? "text-muted-foreground/75 cursor-not-allowed hover:text-muted-foreground/75"
                        : ""
                    }`}
                  >
                    <span>{item.label}</span>
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute left-2 right-2 -bottom-px h-0.5 bg-(--accent-primary)"
                      />
                    )}
                  </button>
                );
              })}
            </nav>
            <div
              className="flex items-center gap-1 md:gap-1.5 ml-auto"
              style={isElectron ? noDragStyle : undefined}
            >
              <ThemeToggle />
              <button
                onClick={toggleLocale}
                aria-label={
                  locale === "zh-CN"
                    ? t("onboarding.localeEn", "Switch to English")
                    : t("onboarding.localeZh", "Switch to Chinese")
                }
                className="hidden md:flex items-center justify-center h-9 min-w-9 px-2.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary hover:bg-muted/40 transition-colors rounded-(--radius-control)"
              >
                {locale === "zh-CN" ? "EN" : "ZH"}
              </button>
              {!isSession && (
                <Button
                  variant="default"
                  asChild
                  className="hidden md:flex h-9 ml-1.5 px-4 text-[11px] font-semibold uppercase tracking-widest rounded-(--radius-control)"
                >
                  <Link to="/session">
                    {t("nav.getStarted", "Get Started")}
                  </Link>
                </Button>
              )}
              {/* The desktop nav and the language toggle are both `md:` only,
                  so on a phone this dialog is the ONLY way to reach worlds /
                  session / plugins / debug or switch language. Radix Dialog
                  brings the focus trap, Escape handling and aria-modal that a
                  hand-rolled dropdown would have to reimplement. */}
              <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("nav.primary", "Primary")}
                    className="md:hidden h-9 w-9 text-muted-foreground hover:text-primary hover:bg-muted/40 rounded-(--radius-control)"
                  >
                    <Menu className="h-4 w-4" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-xs">
                  <DialogHeader>
                    <DialogTitle>{t("nav.primary", "Primary")}</DialogTitle>
                  </DialogHeader>
                  <nav className="flex flex-col">
                    {navItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={item.disabled}
                        aria-current={
                          activeNav === item.id ? "page" : undefined
                        }
                        onClick={() => {
                          setMobileNavOpen(false);
                          item.onClick();
                        }}
                        className={`h-11 px-2 text-left text-sm transition-colors rounded-(--radius-control) ${
                          activeNav === item.id
                            ? "text-foreground font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                        } ${item.disabled ? "opacity-50 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground" : ""}`}
                      >
                        {item.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setMobileNavOpen(false);
                        toggleLocale();
                      }}
                      className="h-11 px-2 mt-1 border-t border-border text-left text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {locale === "zh-CN"
                        ? t("onboarding.localeEn", "Switch to English")
                        : t("onboarding.localeZh", "Switch to Chinese")}
                    </button>
                  </nav>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col w-full min-h-0 overflow-hidden relative">
          <AppErrorBoundary>
            <Outlet />
          </AppErrorBoundary>
        </main>

        {!isHome && (
          <footer
            className={`ui-panel-footer shrink-0 border-t border-border transition-all ${isSession ? "py-1.5" : "py-8"}`}
          >
            <div
              className={`w-full px-4 md:px-6 flex items-center justify-between ${isSession ? "gap-2" : "flex-col md:flex-row gap-6"}`}
            >
              <div
                className={`ui-title flex items-center gap-2 ${isSession ? "text-xs" : "text-base"}`}
              >
                <span
                  className={`rounded-full border border-primary/45 ${isSession ? "h-2 w-2" : "h-3 w-3"}`}
                ></span>
                <span>Covel Studio</span>
              </div>
              <div
                className={`ui-eyebrow text-muted-foreground ${isSession ? "text-[10px]" : "text-xs"}`}
              >
                &copy; {new Date().getFullYear()} Covel Framework.
              </div>
            </div>
          </footer>
        )}
      </div>
      {import.meta.env.DEV &&
        showRouterDevtools &&
        import.meta.env.VITE_ROUTER_DEVTOOLS !== "false" && (
          <TanStackRouterDevtools position="bottom-right" />
        )}
    </>
  );
}
