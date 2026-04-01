import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useTranslation } from "react-i18next";
import { Menu, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const isSession = location.pathname.startsWith('/session') || location.pathname.startsWith('/debug');

  const toggleLocale = () => {
    const next = i18n.language === "zh-CN" ? "en-US" : "zh-CN";
    i18n.changeLanguage(next);
  };

  return (
    <>
      <div className="h-screen w-full bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground flex flex-col overflow-hidden">
        <header className={`flex-shrink-0 z-50 border-b border-border bg-background/95 backdrop-blur-md transition-all ${isSession ? 'h-12' : 'h-16'}`}>
          <div className="w-full flex h-full items-center justify-between px-4 md:px-6">
            <div className="flex items-center gap-8">
              <Link to="/" className={`font-display font-bold tracking-tight flex items-center gap-2 ${isSession ? 'text-lg' : 'text-2xl'}`}>
                <span className={`bg-primary flex items-center justify-center ${isSession ? 'h-4 w-4' : 'h-6 w-6'}`}>
                  <span className={`bg-background rounded-full ${isSession ? 'h-1.5 w-1.5' : 'h-2 w-2'}`}></span>
                </span>
                COVEL
              </Link>
              <nav className="hidden md:flex items-center gap-6 text-xs font-medium uppercase tracking-wider">
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
                className="hidden md:flex items-center justify-center h-9 px-3 text-xs font-semibold uppercase tracking-widest border border-border hover:bg-primary hover:text-primary-foreground transition-colors"
              >
                {i18n.language === "zh-CN" ? "EN" : "中"}
              </button>
              {!isSession && (
                <Button variant="default" asChild className="hidden md:flex h-9 rounded-none text-xs font-semibold uppercase tracking-widest">
                  <Link to="/session">{t("nav.getStarted", "Get Started")}</Link>
                </Button>
              )}
              <Button variant="ghost" size="icon" className="md:hidden rounded-none h-9 w-9">
                <Menu className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col w-full min-h-0 overflow-hidden relative">
          <Outlet />
        </main>

        <footer className={`flex-shrink-0 border-t border-border transition-all bg-background ${isSession ? 'py-1.5' : 'py-8'}`}>
          <div className={`w-full px-4 md:px-6 flex items-center justify-between ${isSession ? 'gap-2' : 'flex-col md:flex-row gap-6'}`}>
            <div className={`flex items-center gap-2 font-display font-bold ${isSession ? 'text-xs' : 'text-base'}`}>
              <span className={`bg-primary ${isSession ? 'h-2 w-2' : 'h-3 w-3'}`}></span>
              COVEL STUDIO
            </div>
            <div className={`text-muted-foreground uppercase tracking-widest ${isSession ? 'text-[10px]' : 'text-xs'}`}>
              &copy; {new Date().getFullYear()} Covel Framework.
            </div>
          </div>
        </footer>
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </>
  );
}
