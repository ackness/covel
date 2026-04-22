import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useInView } from "@/hooks/use-in-view";

export function DemoSection() {
  const { t } = useTranslation();
  const [containerRef, inView] = useInView<HTMLDivElement>({
    threshold: 0.25,
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Lazy-start playback only when on screen — saves CPU when off-screen.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (inView) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [inView]);

  return (
    <section
      aria-labelledby="demo-heading"
      className="relative w-full bg-background border-t border-border"
    >
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-20 md:py-28">
        <header className="max-w-3xl mb-12">
          <span className="ui-eyebrow text-muted-foreground">
            {t("home.demo.eyebrow", "See it run")}
          </span>
          <h2
            id="demo-heading"
            className="font-display text-4xl md:text-6xl font-bold tracking-tight mt-4 leading-[1.05]"
          >
            {t(
              "home.demo.title",
              "A real session, no marketing magic.",
            )}
          </h2>
          <p className="mt-6 text-lg text-muted-foreground font-light leading-relaxed">
            {t(
              "home.demo.subtitle",
              "Streaming narrative, plugin panels reacting in real time, model slot routing — the actual app, captured live.",
            )}
          </p>
        </header>

        <div
          ref={containerRef}
          className="relative rounded-[var(--radius-card)] overflow-hidden border border-border bg-card transition-all duration-700"
          style={{
            opacity: inView ? 1 : 0,
            transform: inView ? "translateY(0)" : "translateY(32px)",
            boxShadow: inView
              ? "0 40px 100px -40px color-mix(in oklab, var(--color-primary) 25%, transparent)"
              : "none",
          }}
        >
          <video
            ref={videoRef}
            className="w-full h-auto block"
            src="/media/demo.mp4"
            poster="/media/demo-poster.jpg"
            muted
            loop
            playsInline
            preload="metadata"
            aria-label={t(
              "home.demo.videoAria",
              "Recording of a Covel session in progress",
            )}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none"
            style={{
              boxShadow:
                "inset 0 0 0 1px color-mix(in oklab, var(--color-foreground) 6%, transparent)",
            }}
          />
        </div>

        <ul className="grid grid-cols-2 md:grid-cols-4 gap-px mt-px bg-border border border-border border-t-0 rounded-b-[var(--radius-card)] overflow-hidden">
          <Stat
            label={t("home.demo.stat1Label", "Plugins active")}
            value={t("home.demo.stat1Value", "8")}
          />
          <Stat
            label={t("home.demo.stat2Label", "Avg. first token")}
            value={t("home.demo.stat2Value", "~640ms")}
          />
          <Stat
            label={t("home.demo.stat3Label", "Backends supported")}
            value={t("home.demo.stat3Value", "4")}
          />
          <Stat
            label={t("home.demo.stat4Label", "Lines of plugin code")}
            value={t("home.demo.stat4Value", "Yours")}
          />
        </ul>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li className="bg-card p-5 md:p-6">
      <div className="ui-eyebrow text-muted-foreground mb-2">{label}</div>
      <div className="font-display text-2xl md:text-3xl font-bold tracking-tight">
        {value}
      </div>
    </li>
  );
}
