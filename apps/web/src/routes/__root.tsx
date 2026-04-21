import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { useLocalePreference } from "@/hooks/useLocalePreference";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocalePreference();
  const location = useLocation();
  const isSession = location.pathname.startsWith('/session') || location.pathname.startsWith('/debug');

  const toggleLocale = () => {
    setLocale(locale === "zh-CN" ? "en-US" : "zh-CN");
  };

  return (
    <>
      <OnboardingWizard />
      <div className="h-screen w-full bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground flex flex-col overflow-hidden">
        <header className={`ui-panel-header flex-shrink-0 z-50 border-b border-border/80 backdrop-blur-md transition-all ${isSession ? 'h-12' : 'h-16'}`}>
          <div className="w-full flex h-full items-center justify-between px-4 md:px-6">
            <div className="flex items-center gap-8 md:gap-6">
              <Link to="/" className={`ui-title flex items-center gap-2 tracking-tight ${isSession ? 'text-lg' : 'text-2xl'}`}>
                <span className={`flex items-center justify-center rounded-full border border-primary/45 ${isSession ? 'h-4 w-4' : 'h-6 w-6'}`}>
                  <span className={`rounded-full bg-primary ${isSession ? 'h-1.5 w-1.5' : 'h-2 w-2'}`}></span>
                </span>
                <span>Covel</span>
              </Link>
              <nav className="hidden md:flex items-center gap-6 text-xs font-medium tracking-[0.14em] uppercase">
                <Link
                  to="/session"
                  className="text-muted-foreground hover:text-primary transition-colors [&.active]:text-primary"
                >
                  {t("nav.studio", "Studio")}
                </Link>
                <Link
                  to="/debug"
                  className="text-muted-foreground hover:text-primary transition-colors [&.active]:text-primary"
                >
                  {t("nav.debug", "Debugger")}
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <button
                onClick={toggleLocale}
                className="hidden md:flex items-center justify-center h-9 px-3 text-xs font-semibold uppercase tracking-widest border border-border/80 hover:bg-primary hover:text-primary-foreground transition-colors rounded-[var(--radius-control)]"
              >
                {locale === "zh-CN" ? "EN" : "中"} {/* i18n-allow: toggle shows the *other* language */}
              </button>
              {!isSession && (
                <Button variant="default" asChild className="hidden md:flex h-9 text-xs font-semibold uppercase tracking-widest">
                  <Link to="/session">{t("nav.getStarted", "Get Started")}</Link>
                </Button>
              )}
              <Button variant="ghost" size="icon" className="md:hidden h-9 w-9">
                <Menu className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col w-full min-h-0 overflow-hidden relative">
          <Outlet />
        </main>

        <footer className={`ui-panel-footer flex-shrink-0 border-t border-border transition-all ${isSession ? 'py-1.5' : 'py-8'}`}>
          <div className={`w-full px-4 md:px-6 flex items-center justify-between ${isSession ? 'gap-2' : 'flex-col md:flex-row gap-6'}`}>
            <div className={`ui-title flex items-center gap-2 ${isSession ? 'text-xs' : 'text-base'}`}>
              <span className={`rounded-full border border-primary/45 ${isSession ? 'h-2 w-2' : 'h-3 w-3'}`}></span>
              <span>Covel Studio</span>
            </div>
            <div className={`ui-eyebrow text-muted-foreground ${isSession ? 'text-[10px]' : 'text-xs'}`}>
              &copy; {new Date().getFullYear()} Covel Framework.
            </div>
          </div>
        </footer>
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </>
  );
}
