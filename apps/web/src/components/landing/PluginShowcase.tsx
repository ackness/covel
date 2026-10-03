import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInView } from "@/hooks/use-in-view";
import { useI18nResolver } from "@/lib/catalog/helpers";
import { stageLabel } from "@/lib/stage-label.js";
import { listPlugins } from "@/services/api.js";
import type { I18nText, PluginSummary, Stage } from "@covel/shared";

/**
 * Marketing tile descriptor. Only the visual layout (`span`) and the
 * `capability` slot are framework-owned. The plugin's display name and blurb
 * are read from the plugin's manifest at fetch time so the framework never
 * hardcodes plugin-specific copy or i18n keys (framework/plugin isolation rule).
 *
 * `capability` must be one a plugin lists under `provides`. `stage` and the
 * blurb describe the capability, not a plugin: they show until the plugin list
 * loads, and stay when the page is served without a backend.
 */
interface Tile {
  key: string;
  capability: string;
  stage: Stage;
  blurbKey: string;
  blurbFallback: string;
  span: string;
  icon: string;
}

const TILES: readonly Tile[] = [
  {
    key: "narrator",
    capability: "narrative-engine@1",
    stage: "narrative",
    blurbKey: "home.plugins.narratorBlurb",
    blurbFallback:
      "Produces the main narrative output and shapes the text the player reads this turn.",
    span: "md:col-span-3 md:row-span-2",
    icon: "/visuals/ui/world-gate.svg",
  },
  {
    key: "world-init",
    capability: "world-data-provider@1",
    stage: "setup",
    blurbKey: "home.plugins.worldInitBlurb",
    blurbFallback:
      "Prepares world structure and seed data before the main loop begins.",
    span: "md:col-span-3 md:row-span-1",
    icon: "/visuals/ui/world-gate.svg",
  },
  {
    key: "events",
    capability: "story-event-cue@1",
    stage: "pre-turn",
    blurbKey: "home.plugins.eventsBlurb",
    blurbFallback:
      "Reveals the world's hidden events once their conditions hold and hands the story a cue for this turn.",
    span: "md:col-span-3 md:row-span-1",
    icon: "/visuals/ui/image-spark.svg",
  },
  {
    key: "facts",
    capability: "world-ir-provider@1",
    stage: "post-turn",
    blurbKey: "home.plugins.factsBlurb",
    blurbFallback:
      "Extracts each turn's people, relations, events, and clues once, for every bookkeeping plugin to reuse.",
    span: "md:col-span-2 md:row-span-1",
    icon: "/visuals/ui/plugin-node.svg",
  },
  {
    key: "rules",
    capability: "action-check@1",
    stage: "pre-turn",
    blurbKey: "home.plugins.rulesBlurb",
    blurbFallback:
      "Handles rules, dice, and modifiers where deterministic logic belongs.",
    span: "md:col-span-2 md:row-span-1",
    icon: "/visuals/ui/plugin-node.svg",
  },
  {
    key: "characters",
    capability: "character-creation@1",
    stage: "setup",
    blurbKey: "home.plugins.charactersBlurb",
    blurbFallback:
      "Tracks NPCs, relationships, and character fields as structured records.",
    span: "md:col-span-2 md:row-span-1",
    icon: "/visuals/ui/covel-mark.svg",
  },
];

export interface PluginMatch {
  id: string;
  displayName: I18nText;
  description: I18nText;
  /** Stage of the runtime that outputs the capability, when it has one. */
  stage?: Stage;
}

const SOURCE_RANK: Record<PluginSummary["source"], number> = {
  builtin: 0,
  community: 1,
};

/**
 * Resolve `capability → plugin`. When several plugins provide a capability,
 * the one that declares itself its default wins, then builtin over community.
 */
export function indexByCapability(
  plugins: readonly PluginSummary[],
): Map<string, PluginMatch> {
  const best = new Map<string, { rank: number; match: PluginMatch }>();
  for (const plugin of plugins) {
    for (const entry of plugin.provides) {
      const capability = typeof entry === "string" ? entry : entry.contract;
      const isDefault = typeof entry !== "string" && entry.default === true;
      const rank =
        (isDefault ? 0 : 10) + (SOURCE_RANK[plugin.source ?? "community"] ?? 3);
      if ((best.get(capability)?.rank ?? Infinity) <= rank) continue;
      const stage = plugin.runtimes.find(
        (runtime) => runtime.outputContract === capability,
      )?.stage;
      best.set(capability, {
        rank,
        match: {
          id: plugin.id,
          displayName: plugin.displayName,
          description: plugin.description,
          ...(stage ? { stage } : {}),
        },
      });
    }
  }
  return new Map(
    [...best].map(([capability, { match }]) => [capability, match]),
  );
}

export function PluginShowcase() {
  const { t } = useTranslation();
  const resolveI18n = useI18nResolver();
  const [headerRef, headerInView] = useInView<HTMLDivElement>({
    threshold: 0.3,
  });
  // `null` until the plugin list has loaded; it stays `null` without a backend.
  const [capabilityToPlugin, setCapabilityToPlugin] = useState<Map<
    string,
    PluginMatch
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const plugins = await listPlugins({ silentErrors: true });
        if (cancelled) return;
        setCapabilityToPlugin(indexByCapability(plugins));
      } catch {
        // Landing page renders without a backend — silent fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useMemo(
    () =>
      TILES.map((tile) => {
        const match = capabilityToPlugin?.get(tile.capability);
        return {
          tile,
          stage: match?.stage ?? tile.stage,
          pluginId: match?.id,
          displayName: match?.displayName
            ? resolveI18n(match.displayName)
            : undefined,
          description: match?.description
            ? resolveI18n(match.description)
            : undefined,
          // A loaded list with no provider is a real gap; an unloaded list
          // only means there is nothing to read the plugin from.
          unclaimed: capabilityToPlugin !== null && !match,
        };
      }),
    [capabilityToPlugin, resolveI18n],
  );

  return (
    <section
      aria-labelledby="plugins-heading"
      className="relative w-full bg-card border-t border-border"
    >
      <div className="max-w-350 mx-auto px-6 md:px-10 py-20 md:py-28">
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
              {t("home.plugins.eyebrow", "Plugin system")}
            </span>
            <h2
              id="plugins-heading"
              className="font-display text-4xl md:text-6xl font-bold tracking-tight mt-4 leading-[1.05]"
            >
              {t(
                "home.plugins.title",
                "Split gameplay, rules, and surfaces into modules.",
              )}
            </h2>
          </div>
          <p className="md:col-span-5 text-base md:text-lg text-muted-foreground font-light leading-relaxed">
            {t(
              "home.plugins.subtitle",
              "Each plugin declares its trigger, stage, and tool scope. The kernel handles scheduling, and the product layer stays replaceable.",
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 md:auto-rows-50 gap-px bg-border border border-border rounded-(--radius-card) overflow-hidden">
          {cards.map((card, i) => (
            <PluginCard
              key={card.tile.key}
              tile={card.tile}
              stage={card.stage}
              unclaimed={card.unclaimed}
              pluginId={card.pluginId}
              displayName={card.displayName}
              description={card.description}
              delay={i * 75}
              t={t}
            />
          ))}
        </div>

        <p className="mt-10 text-sm text-muted-foreground text-center font-light">
          {t(
            "home.plugins.footnote",
            "Bundled plugins are ready to use, and custom plugins follow the same contract.",
          )}
        </p>
      </div>
    </section>
  );
}

interface CardProps {
  tile: Tile;
  stage: Stage;
  unclaimed: boolean;
  pluginId: string | undefined;
  displayName: string | undefined;
  description: string | undefined;
  delay: number;
  t: (key: string, fallback: string) => string;
}

function PluginCard({
  tile,
  stage,
  unclaimed,
  pluginId,
  displayName,
  description,
  delay,
  t,
}: CardProps) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.25 });
  const headline = displayName ?? pluginId ?? tile.capability;
  const blurb =
    description ??
    (unclaimed
      ? t(
          "home.plugins.unfilledSlot",
          "Awaiting a plugin to claim this capability.",
        )
      : t(tile.blurbKey, tile.blurbFallback));
  return (
    <article
      ref={ref}
      className={`group relative overflow-hidden bg-card p-6 md:p-7 flex flex-col justify-between transition-all duration-500 hover:bg-muted/30 ${tile.span}`}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(16px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      <img
        src={tile.icon}
        alt=""
        aria-hidden="true"
        className="absolute right-4 top-4 h-20 w-20 opacity-[0.08] transition-all duration-300 group-hover:opacity-[0.16] group-hover:scale-105"
        draggable={false}
      />
      <header className="flex items-start justify-between mb-4">
        <span className="ui-eyebrow text-muted-foreground">
          {stageLabel(stage, t)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70 uppercase tracking-wider">
          {tile.capability}
        </span>
      </header>
      <div className="flex-1 flex flex-col justify-end">
        <h3 className="font-mono text-xs text-muted-foreground mb-2">
          {pluginId ?? tile.capability}
        </h3>
        <p className="font-display text-base md:text-lg leading-snug text-foreground/90 group-hover:text-foreground transition-colors">
          {headline !== (pluginId ?? tile.capability) ? (
            <span className="block font-sans text-foreground mb-1">
              {headline}
            </span>
          ) : null}
          <span className="line-clamp-3">{blurb}</span>
        </p>
      </div>
    </article>
  );
}
