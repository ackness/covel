import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, Cpu, Code2, Database, Zap } from "lucide-react";
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

      {/* Stack Section */}
      <section className="py-24 border-t border-border px-6 md:px-10 max-w-[1400px] mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border">
          
          <div className="bg-background p-10 flex flex-col justify-between min-h-[320px] group hover:bg-muted/30 transition-colors">
            <div className="mb-12">
              <div className="h-12 w-12 border-2 border-primary flex items-center justify-center mb-6">
                <Zap className="h-6 w-6" />
              </div>
              <h3 className="font-display text-2xl font-bold mb-3">Vite 8</h3>
              <p className="text-muted-foreground font-light leading-relaxed">
                Lightning fast frontend tooling powered by Rolldown for instantaneous HMR and optimized builds.
              </p>
            </div>
            <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary transition-colors">
              01 // Frontend
            </div>
          </div>

          <div className="bg-background p-10 flex flex-col justify-between min-h-[320px] group hover:bg-muted/30 transition-colors">
            <div className="mb-12">
              <div className="h-12 w-12 border-2 border-primary flex items-center justify-center mb-6">
                <Code2 className="h-6 w-6" />
              </div>
              <h3 className="font-display text-2xl font-bold mb-3">React 19</h3>
              <p className="text-muted-foreground font-light leading-relaxed">
                Modern component model using tanstack-router for declarative, type-safe navigation.
              </p>
            </div>
            <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary transition-colors">
              02 // UI View
            </div>
          </div>

          <div className="bg-background p-10 flex flex-col justify-between min-h-[320px] group hover:bg-muted/30 transition-colors">
            <div className="mb-12">
              <div className="h-12 w-12 border-2 border-primary flex items-center justify-center mb-6">
                <Cpu className="h-6 w-6" />
              </div>
              <h3 className="font-display text-2xl font-bold mb-3">Hono</h3>
              <p className="text-muted-foreground font-light leading-relaxed">
                Ultrafast web framework for the API layer executing state patches and runtime plugins.
              </p>
            </div>
            <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary transition-colors">
              03 // API Layer
            </div>
          </div>

          <div className="bg-background p-10 flex flex-col justify-between min-h-[320px] group hover:bg-muted/30 transition-colors">
            <div className="mb-12">
              <div className="h-12 w-12 border-2 border-primary flex items-center justify-center mb-6">
                <Database className="h-6 w-6" />
              </div>
              <h3 className="font-display text-2xl font-bold mb-3">Drizzle</h3>
              <p className="text-muted-foreground font-light leading-relaxed">
                Type-safe ORM connecting to PostgreSQL 17 to persist runs, states, and event records.
              </p>
            </div>
            <div className="text-sm font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary transition-colors">
              04 // Persistence
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
