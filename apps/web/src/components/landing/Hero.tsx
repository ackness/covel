import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";

const REPO_URL = "https://github.com/ackness/covel";

export function Hero() {
  const { t } = useTranslation();

  return (
    <section
      aria-labelledby="hero-heading"
      className="relative w-full h-full min-h-[560px] sm:min-h-[640px] flex items-stretch overflow-hidden bg-background"
    >
      {/* Ambient video — desktop only. On mobile the gradient overpowers the
          tiny remaining viewport and the video just adds noise + bandwidth. */}
      <div
        className="absolute inset-0 pointer-events-none hidden md:block"
        aria-hidden="true"
      >
        <div className="absolute right-0 top-0 h-full w-full md:w-[62%] overflow-hidden">
          <video
            className="h-full w-full object-cover opacity-60"
            src="/media/demo.mp4"
            poster="/media/demo-poster.jpg"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            style={{ filter: "saturate(0.85) contrast(1.05)" }}
          />
          {/* Left→right fade so the headline sits on flat surface, plus a
              soft top + bottom fade to dissolve the video edges into the page
              instead of a hard horizontal seam. */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, var(--surface-app) 0%, color-mix(in oklab, var(--surface-app) 85%, transparent) 30%, color-mix(in oklab, var(--surface-app) 35%, transparent) 65%, color-mix(in oklab, var(--surface-app) 60%, transparent) 100%)",
            }}
          />
          <div
            className="absolute inset-x-0 top-0 h-32"
            style={{
              background:
                "linear-gradient(180deg, var(--surface-app) 0%, transparent 100%)",
            }}
          />
          <div
            className="absolute inset-x-0 bottom-0 h-32"
            style={{
              background:
                "linear-gradient(0deg, var(--surface-app) 0%, transparent 100%)",
            }}
          />
        </div>
      </div>

      <div className="relative z-10 w-full max-w-[1400px] mx-auto px-5 sm:px-6 md:px-10 py-12 sm:py-16 md:py-24 flex flex-col justify-between gap-10 md:gap-0">
        <div className="flex-1 flex flex-col justify-center max-w-3xl">
          <span className="ui-eyebrow text-muted-foreground mb-5 md:mb-6">
            {t("home.heroEyebrow", "v0.1.0 · Plugin-first AI RPG runtime")}
          </span>
          <h1
            id="hero-heading"
            className="font-display text-[clamp(2.75rem,9vw,8rem)] lg:text-9xl font-bold tracking-tight leading-[0.92] mb-6 md:mb-8 break-words"
          >
            {t("home.heroLine1", "Stories")}
            <br />
            <span className="text-muted-foreground italic font-light">
              {t("home.heroLine2", "that listen.")}
            </span>
          </h1>
          <p className="text-base sm:text-lg md:text-xl text-muted-foreground max-w-xl font-light leading-relaxed mb-8 md:mb-10">
            {t(
              "home.heroBody",
              "Covel routes every turn through plugins you can swap, inspect, and replace — from the trigger that fires to the words you read.",
            )}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              size="lg"
              asChild
              className="h-12 px-6 sm:px-7 text-sm rounded-[var(--radius-control)] font-medium uppercase tracking-wider"
            >
              <Link to="/session">
                {t("home.startPlaying", "Start Playing")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              asChild
              className="h-12 px-6 sm:px-7 text-sm rounded-[var(--radius-control)] font-medium uppercase tracking-wider"
            >
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                {t("home.viewRepository", "View Repository")}
              </a>
            </Button>
          </div>
        </div>

        <div className="flex items-end justify-between gap-6">
          <p className="ui-eyebrow text-muted-foreground/70 max-w-xs hidden md:block">
            {t(
              "home.heroFootnote",
              "Trigger → Context → LLM → Tool loop → Proposal → Commit → Render. Scroll to follow a single turn.",
            )}
          </p>
          <div className="flex items-center gap-2 text-muted-foreground animate-bounce-slow ml-auto">
            <span className="ui-eyebrow">
              {t("home.scrollHint", "Scroll")}
            </span>
            <ArrowDown className="h-4 w-4" />
          </div>
        </div>
      </div>
    </section>
  );
}
