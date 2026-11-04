import {
  createRootRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  Bug,
  Globe2,
  Menu,
  MessageSquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { emitToast } from "@/lib/toast-channel.js";
import { emitSettingsRequest, emitWorldListRequest } from "@/lib/nav-events.js";
import {
  receiveSettingsBackupNotices,
  settingLabels,
} from "@/settings/store.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NoticeHost, useNoticeAnchor } from "@/components/ui/notice-host";
import { NoticeBell } from "@/components/notice-bell";
import { ConfirmHost } from "@/components/ui/confirm-host";
import { AppErrorBoundary } from "@/components/error-boundary";
import { useSharedServerNotice } from "@/components/shared-server-notice";
import { useWindowControlsColors } from "@/hooks/use-window-controls-colors.js";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { useSession } from "@/stores/session-store";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";
import { useSetting } from "@/settings/use-settings.js";

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
  // Runs after the notice host below has subscribed. Most of these notices
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
  useSharedServerNotice();
  const [developerMode] = useSetting<boolean>("ui.developerView");
  const layoutNav = useThemeLayout().nav;
  const location = useLocation();
  const navigate = useNavigate();
  const isSessionRoute = location.pathname.startsWith("/session");
  const isDebugRoute = location.pathname.startsWith("/debug");
  const railNav = layoutNav === "rail";
  const headerRef = useRef<HTMLElement>(null);
  useNoticeAnchor(headerRef);
  useWindowControlsColors(headerRef, railNav);

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

  // Active state for the primary nav: real routes only. Settings is a dialog.
  type NavId = "world" | "session" | "settings" | "debug";
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
    emitWorldListRequest();
  };
  const goSession = () => navigate({ to: "/session", search: sessionSearch });
  const goSettings = () => {
    emitSettingsRequest();
    // The debugger has no dialog; the session screen picks the request up.
    if (isDebugRoute) navigate({ to: "/session", search: sessionSearch });
  };
  const goDebug = () => navigate({ to: "/debug", search: navSearch });

  const navItems: Array<{
    id: NavId;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
  }> = [
    { id: "world", label: t("nav.world"), icon: Globe2, onClick: goWorld },
    // Nothing greyed out: Games exists only while a game is open.
    ...(hasSession
      ? [
          {
            id: "session" as const,
            label: t("nav.session"),
            icon: MessageSquare,
            onClick: goSession,
          },
        ]
      : []),
    {
      id: "settings",
      label: t("nav.settings"),
      icon: Settings,
      onClick: goSettings,
    },
    ...(developerMode
      ? [
          {
            id: "debug" as const,
            label: t("nav.debug"),
            icon: Bug,
            onClick: goDebug,
          },
        ]
      : []),
  ];

  // Electron hides the native title bar so the in-app header can follow the
  // active theme. On macOS we pad-left to clear the inset traffic lights.
  const ipc = getCovelIpc();
  const isElectron = ipc !== null;
  const isMacDesktop = isElectron && ipc?.platform === "darwin";

  const brand = (
    <Link
      to="/session"
      className="ui-brand-title ui-title flex shrink-0 items-center gap-2 tracking-tight text-lg"
      style={isElectron ? noDragStyle : undefined}
    >
      <img
        src="/icon.png"
        alt=""
        aria-hidden="true"
        className="h-6 w-6 rounded-md object-cover"
        draggable={false}
      />
      <span>Covel</span>
    </Link>
  );

  return (
    <>
      <NoticeHost />
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
              to="/session"
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
                    aria-current={isActive ? "page" : undefined}
                    className={`ui-nav-item flex h-13 w-14 flex-col items-center justify-center gap-1 rounded-(--radius-control) text-[11px] leading-none transition-colors ${
                      isActive
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
              <NoticeBell {...(activeSid ? { sessionId: activeSid } : {})} />
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
            ref={headerRef}
            className={`ui-app-header ui-panel-header relative shrink-0 z-50 border-b border-border/80 backdrop-blur-md transition-all h-12 ${railNav ? "lg:hidden" : ""}`}
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
                      aria-current={isActive ? "page" : undefined}
                      className={`ui-nav-item relative h-8 px-3 transition-colors rounded-(--radius-control) ${
                        isActive
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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
                <NoticeBell {...(activeSid ? { sessionId: activeSid } : {})} />
                {/* The desktop nav is `lg:` only, so on a phone this dialog
                    is the ONLY way to reach worlds / games / settings. */}
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
                aria-current={activeNav === item.id ? "page" : undefined}
                onClick={() => {
                  setMobileNavOpen(false);
                  item.onClick();
                }}
                className={`h-11 px-2 text-left text-sm transition-colors rounded-(--radius-control) ${
                  activeNav === item.id
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
}
