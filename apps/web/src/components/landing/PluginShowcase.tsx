import { useTranslation } from "react-i18next";
import { useInView } from "@/hooks/use-in-view";

interface Tile {
  key: string;
  pluginId: string;
  bandKey: string;
  bandFallback: string;
  blurbKey: string;
  blurbFallback: string;
  capability: string;
  span: string;
}

const TILES: readonly Tile[] = [
  {
    key: "narrator",
    pluginId: "core-narrator",
    bandKey: "home.plugins.narratorBand",
    bandFallback: "Narrator · 500",
    blurbKey: "home.plugins.narratorBlurb",
    blurbFallback:
      "Owns the prose. Streams the narrator's voice token-by-token, never blocks the next turn.",
    capability: "narrative",
    span: "md:col-span-3 md:row-span-2",
  },
  {
    key: "world-init",
    pluginId: "core-world-init",
    bandKey: "home.plugins.worldInitBand",
    bandFallback: "Pre-Game · 0–99",
    blurbKey: "home.plugins.worldInitBlurb",
    blurbFallback: "Generates a world schema before turn 1, then steps aside.",
    capability: "world-data-provider",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    key: "image",
    pluginId: "core-image",
    bandKey: "home.plugins.imageBand",
    bandFallback: "After-Turn · 700",
    blurbKey: "home.plugins.imageBlurb",
    blurbFallback:
      "Watches the narrative for visual moments and proposes an image render.",
    capability: "image-generation",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    key: "memory",
    pluginId: "core-memory",
    bandKey: "home.plugins.memoryBand",
    bandFallback: "Audit · 1000",
    blurbKey: "home.plugins.memoryBlurb",
    blurbFallback:
      "Letta-style core blocks plus archival recall. Long-term, indexable, replaceable.",
    capability: "memory",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    key: "rules",
    pluginId: "core-rules",
    bandKey: "home.plugins.rulesBand",
    bandFallback: "Pre-Turn · 200",
    blurbKey: "home.plugins.rulesBlurb",
    blurbFallback:
      "House rules, dice math, modifiers — pure functions, zero LLM cost.",
    capability: "rules-engine",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    key: "characters",
    pluginId: "core-characters",
    bandKey: "home.plugins.charactersBand",
    bandFallback: "After-Turn · 600",
    blurbKey: "home.plugins.charactersBlurb",
    blurbFallback:
      "Tracks NPCs, relationships, and character state through typed records.",
    capability: "character-management",
    span: "md:col-span-3 md:row-span-1",
  },
];

export function PluginShowcase() {
  const { t } = useTranslation();
  const [headerRef, headerInView] = useInView<HTMLDivElement>({
    threshold: 0.3,
  });

  return (
    <section
      aria-labelledby="plugins-heading"
      className="relative w-full bg-card border-t border-border"
    >
      <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-20 md:py-28">
        <div
          ref={headerRef}
          className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-12 items-end mb-12 md:mb-16 transition-all duration-700"
          style={{
            opacity: headerInView ? 1 : 0,
            transform: headerInView ? "translateY(0)" : "translateY(24px)",
          }}
        >
          <div className="md:col-span-7">
            <span className="ui-eyebrow text-muted-foreground">
              {t("home.plugins.eyebrow", "Plugins are first-class")}
            </span>
            <h2
              id="plugins-heading"
              className="font-display text-4xl md:text-6xl font-bold tracking-tight mt-4 leading-[1.05]"
            >
              {t(
                "home.plugins.title",
                "Eight runtimes. One pipeline. Zero hardcoded gameplay.",
              )}
            </h2>
          </div>
          <p className="md:col-span-5 text-base md:text-lg text-muted-foreground font-light leading-relaxed">
            {t(
              "home.plugins.subtitle",
              "Every plugin declares a priority band, a trigger mode, and a tool whitelist. The kernel discovers them by capability — never by ID.",
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 md:auto-rows-[200px] gap-px bg-border border border-border rounded-[var(--radius-card)] overflow-hidden">
          {TILES.map((tile, i) => (
            <PluginCard
              key={tile.key}
              tile={tile}
              delay={i * 75}
              t={t}
            />
          ))}
        </div>

        <p className="mt-10 text-sm text-muted-foreground text-center font-light">
          {t(
            "home.plugins.footnote",
            "Three more bundled plugins: dice, debug, slot-router. Drop in your own — same contract.",
          )}
        </p>
      </div>
    </section>
  );
}

interface CardProps {
  tile: Tile;
  delay: number;
  t: (key: string, fallback: string) => string;
}

function PluginCard({ tile, delay, t }: CardProps) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.25 });
  return (
    <article
      ref={ref}
      className={`group bg-card p-6 md:p-7 flex flex-col justify-between transition-all duration-500 hover:bg-muted/30 ${tile.span}`}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(16px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      <header className="flex items-start justify-between mb-4">
        <span className="ui-eyebrow text-muted-foreground">
          {t(tile.bandKey, tile.bandFallback)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70 uppercase tracking-wider">
          {tile.capability}
        </span>
      </header>
      <div className="flex-1 flex flex-col justify-end">
        <h3 className="font-mono text-xs text-muted-foreground mb-2">
          {tile.pluginId}
        </h3>
        <p className="font-display text-base md:text-lg leading-snug text-foreground/90 group-hover:text-foreground transition-colors">
          {t(tile.blurbKey, tile.blurbFallback)}
        </p>
      </div>
    </article>
  );
}
