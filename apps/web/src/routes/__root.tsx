import {
  createRootRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  Blocks,
  Bug,
  Globe2,
  Image as ImageIcon,
  Menu,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { localeDefinitions } from "@/i18n/catalog-registry.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  receiveSettingsBackupNotices,
  settingLabels,
} from "@/settings/store.js";
import { localeOptionLabel } from "@/i18n/locale-option-label.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { ToastHost } from "@/components/ui/toast-host";
import { ConfirmHost } from "@/components/ui/confirm-host";
import { AppErrorBoundary } from "@/components/error-boundary";
import { useLocalePreference } from "@/hooks/useLocalePreference";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { useSession } from "@/stores/session-store";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";

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
  // Runs after the toast host below has subscribed. Most of these notices
  // arise during boot, before anything could show a message.
  useEffect(
    () =>
      receiveSettingsBackupNotices(({ backup, keys }) => {
        emitToast(
          "info",
          t(
            keys
              ? "settings.refusedSettingsReset"
              : "settings.earlierSettingsArchived",
          ),
          keys
            ? t("settings.refusedSettingsResetDetail", {
                keys: settingLabels(keys),
                backup,
              })
            : t("settings.earlierSettingsArchivedDetail", { backup }),
          { durationMs: 30_000 },
        );
      }),
    [t],
  );
  const { locale, setLocale } = useLocalePreference();
  const layoutNav = useThemeLayout().nav;
  const location = useLocation();
  const navigate = useNavigate();
  const isSessionRoute = location.pathname.startsWith("/session");
  const isDebugRoute = location.pathname.startsWith("/debug");
  const isSession = isSessionRoute || isDebugRoute;
  // The rail is app chrome. The landing page keeps the top bar in every
  // layout: it carries the brand and the way in.
  const railNav = layoutNav === "rail" && isSession;
  const showRouterDevtools = !isSessionRoute && !isDebugRoute;

  // Carry the active session id between Studio (/session) and Debugger (/debug)
  // so flipping tabs preserves what the user is inspecting. /session has stale-
  // session logic that drops state when it loads without a sid; without this,
  // clicking Studio from /debug would always boot the user back to world-select.
  //
  // /debug doesn't restore the session into SessionProvider, so we must also
  // honour `?sid=` already in the URL. It names the session being inspected,
  // even when Studio still holds a different session from an earlier visit.
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
  const activeSid = urlSid ?? sessionState.session?.id;
  const navSearch = activeSid ? { sid: activeSid } : {};
  const hasSession = !!activeSid;
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
    navigate({
      to: "/session",
      search: { ...sessionSearch, panel: "plugins" },
    });
  };
  const goImages = () => {
    navigate({ to: "/session", search: { ...sessionSearch, panel: "images" } });
  };
  const goDebug = () => navigate({ to: "/debug", search: navSearch });

  const navItems: Array<{
    id: NavId;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    disabled?: boolean;
  }> = [
    { id: "world", label: t("nav.world"), icon: Globe2, onClick: goWorld },
    {
      id: "session",
      label: t("nav.session"),
      icon: MessageSquare,
      onClick: goSession,
      disabled: !hasSession,
    },
    {
      id: "plugins",
      label: t("nav.plugins"),
      icon: Blocks,
      onClick: goPlugins,
      disabled: !hasSession,
    },
    {
      id: "images",
      label: t("nav.images"),
      icon: ImageIcon,
      onClick: goImages,
      disabled: !hasSession,
    },
    { id: "debug", label: t("nav.debug"), icon: Bug, onClick: goDebug },
  ];

  // Electron hides the native title bar so the in-app header can follow the
  // active theme. On macOS we pad-left to clear the inset traffic lights.
  const ipc = getCovelIpc();
  const isElectron = ipc !== null;
  const isMacDesktop = isElectron && ipc?.platform === "darwin";

  const brand = (
    <Link
      to="/"
      className={`ui-brand-title ui-title flex shrink-0 items-center gap-2 tracking-tight ${isSession ? "text-lg" : "text-2xl"}`}
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
  );

  const languageSelect = (className: string, onPicked?: () => void) => (
    <select
      value={locale}
      onChange={(event) => {
        setLocale(event.target.value);
        onPicked?.();
      }}
      aria-label={t("onboarding.language", "Language")}
      className={className}
    >
      {localeDefinitions.map((definition) => (
        <option key={definition.code} value={definition.code}>
          {localeOptionLabel(
            definition,
            t("onboarding.languageExperimental", "experimental"),
          )}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <ToastHost />
      <ConfirmHost />
      <div className="ui-app-shell h-dvh w-full bg-transparent text-foreground font-sans selection:bg-primary selection:text-primary-foreground flex overflow-hidden">
        {/* Icon rail — the `nav: "rail"` layout. Desktop widths only; phones
            keep the top bar and its menu dialog. */}
        {railNav && (
          <aside
            className={`ui-nav-rail hidden lg:flex w-18 shrink-0 flex-col items-center gap-1 border-r border-(--rule-color) pb-3 ${isMacDesktop ? "pt-10" : "pt-3"}`}
            style={isElectron ? dragStyle : undefined}
          >
            <Link
              to="/"
              aria-label="Covel"
              className="mb-3 block"
              style={isElectron ? noDragStyle : undefined}
            >
              <img
                src="/icon.png"
                alt=""
                aria-hidden="true"
                className="h-9 w-9 rounded-(--radius-control) object-cover"
                draggable={false}
              />
            </Link>
            <nav
              className="flex flex-1 flex-col items-center gap-1"
              style={isElectron ? noDragStyle : undefined}
              aria-label={t("nav.primary", "Primary")}
            >
              {navItems.map((item) => {
                const isActive = activeNav === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.onClick}
                    disabled={item.disabled}
                    aria-current={isActive ? "page" : undefined}
                    className={`ui-nav-item flex h-13 w-14 flex-col items-center justify-center gap-1 rounded-(--radius-control) text-[11px] leading-none transition-colors ${
                      item.id === "debug" ? "mt-auto" : ""
                    } ${
                      isActive
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    } ${
                      item.disabled
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground"
                        : ""
                    }`}
                  >
                    <Icon
                      className={`h-4.5 w-4.5 ${isActive ? "text-(--accent-primary)" : ""}`}
                    />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div
              className="flex flex-col items-center gap-1"
              style={isElectron ? noDragStyle : undefined}
            >
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("onboarding.language", "Language")}
                aria-haspopup="dialog"
                className="h-9 w-9 text-muted-foreground hover:text-primary hover:bg-muted/40 rounded-(--radius-control)"
                onClick={() => setMobileNavOpen(true)}
              >
                <Menu className="h-4 w-4" />
              </Button>
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {railNav && (
            <div
              aria-hidden="true"
              className="ui-window-controls-strip hidden shrink-0 lg:block"
              style={isElectron ? dragStyle : undefined}
            />
          )}
          <header
            className={`ui-app-header ui-panel-header relative shrink-0 z-50 border-b border-border/80 backdrop-blur-md transition-all ${isSession ? "h-12" : "h-16"} ${railNav ? "lg:hidden" : ""}`}
            style={isElectron ? dragStyle : undefined}
          >
            <div
              className={`w-full flex h-full items-center gap-4 lg:gap-7 ${isMacDesktop ? "pl-22 pr-4 md:pr-6" : "px-4 md:px-6"}`}
            >
              {brand}
              <nav
                className="hidden lg:flex items-center gap-1 text-xs font-medium"
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
                      className={`ui-nav-item relative h-8 px-3 transition-colors rounded-(--radius-control) ${
                        isActive
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      } ${
                        item.disabled
                          ? "cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground"
                          : ""
                      }`}
                    >
                      <span>{item.label}</span>
                      {isActive && (
                        <span
                          aria-hidden
                          className="ui-nav-item-marker absolute left-2 right-2 -bottom-px h-0.5 bg-(--accent-primary)"
                        />
                      )}
                    </button>
                  );
                })}
              </nav>
              <div
                className="ui-window-controls-clear flex items-center gap-1 md:gap-1.5 ml-auto"
                style={isElectron ? noDragStyle : undefined}
              >
                <ThemeToggle />
                {/* Inside the app the language is a setting (General). The
                    landing page has no way into Settings, so it keeps the
                    select. */}
                {!isSession && (
                  <label className="hidden lg:block">
                    <span className="sr-only">
                      {t("onboarding.language", "Language")}
                    </span>
                    {languageSelect(
                      "h-9 max-w-40 rounded-(--radius-control) border border-border bg-transparent px-2 text-[11px] font-semibold text-muted-foreground outline-none transition-colors hover:border-primary/40 hover:text-primary focus:border-primary",
                    )}
                  </label>
                )}
                {!isSession && (
                  <Button
                    variant="default"
                    asChild
                    className="hidden lg:flex h-9 ml-1.5 px-4 text-[11px] font-semibold uppercase tracking-widest rounded-(--radius-control)"
                  >
                    <Link to="/session">
                      {t("nav.getStarted", "Get Started")}
                    </Link>
                  </Button>
                )}
                {/* The desktop nav and the language select are both `lg:`
                    only, so on a phone this dialog is the ONLY way to reach
                    worlds / session / plugins / debug or switch language. */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("nav.primary", "Primary")}
                  aria-haspopup="dialog"
                  className="h-10 w-10 text-muted-foreground hover:text-primary hover:bg-muted/40 rounded-(--radius-control) lg:hidden"
                  onClick={() => setMobileNavOpen(true)}
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
        </div>
      </div>

      {/* Radix Dialog brings the focus trap, Escape handling and aria-modal
          that a hand-rolled dropdown would have to reimplement. */}
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
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
                aria-current={activeNav === item.id ? "page" : undefined}
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
            <label className="mt-1 flex min-h-11 items-center gap-3 border-t border-border px-2 text-sm text-muted-foreground">
              <span>{t("onboarding.language", "Language")}</span>
              {languageSelect(
                "ml-auto max-w-48 rounded-(--radius-control) border border-border bg-background px-2 py-1 text-foreground outline-none focus:border-primary",
                () => setMobileNavOpen(false),
              )}
            </label>
          </nav>
        </DialogContent>
      </Dialog>
      {import.meta.env.DEV &&
        showRouterDevtools &&
        import.meta.env.VITE_ROUTER_DEVTOOLS !== "false" && (
          <TanStackRouterDevtools position="bottom-right" />
        )}
    </>
  );
}
