import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, Cpu, Code2, Database, Zap, Compass, Globe2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const REPO_URL = "https://github.com/ackness/covel";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col min-h-full w-full">
      {/* Hero Section */}
      <section className="flex-1 flex flex-col justify-center py-24 md:py-32 px-6 md:px-10 max-w-[1400px] mx-auto w-full">
        <div className="max-w-4xl">
          <Badge variant="outline" className="mb-8 rounded-full border-primary/20 px-4 py-1.5 text-sm uppercase tracking-widest bg-background">
            v0.1.0 Architecture
          </Badge>
          <h1 className="font-display text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-8 leading-[1.1]">
            AI RPG <br/>
            <span className="text-muted-foreground">Framework.</span>
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mb-12 font-light leading-relaxed">
            {t("app.description", "A modular monolith architecture for building plugin-driven role-playing experiences.")}
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <Button size="lg" asChild className="h-14 px-8 text-base rounded-none font-medium uppercase tracking-wider">
              <Link to="/session">
                {t("home.startPlaying", "Start Playing")} <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="h-14 px-8 text-base rounded-none font-medium uppercase tracking-wider border-2">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                {t("home.viewRepository", "View Repository")}
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* For Players — primary-audience callout */}
      <section className="py-20 md:py-24 border-t border-border px-6 md:px-10 max-w-[1400px] mx-auto w-full">
        <div className="max-w-4xl">
          <span className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            {t("home.forPlayersEyebrow", "For players")}
          </span>
          <h2 className="font-display text-3xl md:text-5xl font-bold tracking-tight mt-4 mb-10 leading-[1.15]">
            {t("home.forPlayersTitle", "Step into a story that listens.")}
          </h2>
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <li className="flex flex-col gap-3">
              <Compass className="h-6 w-6 text-primary" aria-hidden="true" />
              <p className="font-display text-lg font-semibold">
                {t("home.playerPointStart", "Start an adventure in seconds.")}
              </p>
              <p className="text-sm text-muted-foreground font-light leading-relaxed">
                {t("home.playerPointStartDesc", "No setup. Pick a world, hit Start Playing, and the narrator responds to your words.")}
              </p>
            </li>
            <li className="flex flex-col gap-3">
              <Globe2 className="h-6 w-6 text-primary" aria-hidden="true" />
              <p className="font-display text-lg font-semibold">
                {t("home.playerPointWorld", "Pick the world that fits your mood.")}
              </p>
              <p className="text-sm text-muted-foreground font-light leading-relaxed">
                {t("home.playerPointWorldDesc", "Cyberpunk, high fantasy, or slow-burn mystery — each world is a self-contained setting with its own tone.")}
              </p>
            </li>
            <li className="flex flex-col gap-3">
              <Sparkles className="h-6 w-6 text-primary" aria-hidden="true" />
              <p className="font-display text-lg font-semibold">
                {t("home.playerPointModel", "Choose how the AI thinks.")}
              </p>
              <p className="text-sm text-muted-foreground font-light leading-relaxed">
                {t("home.playerPointModelDesc", "Swap the underlying model per-slot — fast drafts, deeper reasoning, or your own provider key.")}
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* Under the Hood — de-emphasised tech stack */}
      <section className="py-20 md:py-24 border-t border-border px-6 md:px-10 max-w-[1400px] mx-auto w-full">
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-10">
          <span className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            {t("home.underTheHoodEyebrow", "Under the hood")}
          </span>
          <span className="text-xs text-muted-foreground/70 font-light">
            {t("home.underTheHoodHint", "For the curious — you don't need to care to play.")}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border border border-border">

          <div className="bg-background p-6 flex flex-col justify-between min-h-[180px] group hover:bg-muted/30 transition-colors">
            <div className="mb-6">
              <div className="h-9 w-9 border border-border flex items-center justify-center mb-4 text-muted-foreground group-hover:text-primary group-hover:border-primary transition-colors">
                <Zap className="h-4 w-4" />
              </div>
              <h3 className="font-display text-base font-bold mb-1.5">Vite 8</h3>
              <p className="text-xs text-muted-foreground font-light leading-relaxed">
                Rolldown-powered frontend tooling for instant HMR.
              </p>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
              01 // Frontend
            </div>
          </div>

          <div className="bg-background p-6 flex flex-col justify-between min-h-[180px] group hover:bg-muted/30 transition-colors">
            <div className="mb-6">
              <div className="h-9 w-9 border border-border flex items-center justify-center mb-4 text-muted-foreground group-hover:text-primary group-hover:border-primary transition-colors">
                <Code2 className="h-4 w-4" />
              </div>
              <h3 className="font-display text-base font-bold mb-1.5">React 19</h3>
              <p className="text-xs text-muted-foreground font-light leading-relaxed">
                Typed routing via TanStack Router.
              </p>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
              02 // UI View
            </div>
          </div>

          <div className="bg-background p-6 flex flex-col justify-between min-h-[180px] group hover:bg-muted/30 transition-colors">
            <div className="mb-6">
              <div className="h-9 w-9 border border-border flex items-center justify-center mb-4 text-muted-foreground group-hover:text-primary group-hover:border-primary transition-colors">
                <Cpu className="h-4 w-4" />
              </div>
              <h3 className="font-display text-base font-bold mb-1.5">Hono</h3>
              <p className="text-xs text-muted-foreground font-light leading-relaxed">
                API layer driving runtime and state patches.
              </p>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
              03 // API Layer
            </div>
          </div>

          <div className="bg-background p-6 flex flex-col justify-between min-h-[180px] group hover:bg-muted/30 transition-colors">
            <div className="mb-6">
              <div className="h-9 w-9 border border-border flex items-center justify-center mb-4 text-muted-foreground group-hover:text-primary group-hover:border-primary transition-colors">
                <Database className="h-4 w-4" />
              </div>
              <h3 className="font-display text-base font-bold mb-1.5">Drizzle</h3>
              <p className="text-xs text-muted-foreground font-light leading-relaxed">
                Type-safe ORM persisting runs, states, and events.
              </p>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
              04 // Persistence
            </div>
          </div>

        </div>

        {/* Engineer tertiary link */}
        <div className="mt-10 flex justify-end">
          <Link
            to="/debug"
            className="text-xs uppercase tracking-widest text-muted-foreground/80 hover:text-primary transition-colors inline-flex items-center gap-1.5"
          >
            {t("home.debuggerLink", "Open Debugger")}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </section>
    </div>
  );
}
