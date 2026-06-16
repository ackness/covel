import type { TFunction } from "i18next";
import {
  Sparkles,
  KeyRound,
  Cpu,
  Wand2,
  FolderOpen,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import type { WorldRecord } from "@/services/api.js";
import { WorldCard } from "@/components/world/world-card.js";

export interface WorldListViewProps {
  worlds: WorldRecord[];
  t: TFunction;
  /** Label for the primary configured model slot, if any. */
  primarySlotLabel: string | null;
  /** Count of enabled plugin packages, for the footer chip. */
  enabledPluginCount: number;
  /** World currently being entered (drives per-card busy/dimmed state). */
  enteringWorldId: string | null;
  /** Resolve a storage label for a world (Built-in / Server / Browser …). */
  storageLabel: (world: WorldRecord) => string;
  onOpenGenerator: () => void;
  onOpenSettings: () => void;
  onEnterWorld: (worldId: string) => void;
  onViewDetails: (e: React.MouseEvent, worldId: string) => void;
  onDeleteWorld: (e: React.MouseEvent, worldId: string) => void;
}

/**
 * The list-mode body of the world-select screen: editorial header, the
 * AI-generate / API-keys action rail, the cover-led world grid, the empty
 * state, and the footer info chips.
 */
export function WorldListView({
  worlds,
  t,
  primarySlotLabel,
  enabledPluginCount,
  enteringWorldId,
  storageLabel,
  onOpenGenerator,
  onOpenSettings,
  onEnterWorld,
  onViewDetails,
  onDeleteWorld,
}: WorldListViewProps) {
  return (
    <ScrollArea className="w-full h-full">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-5 md:py-8">
        {/* Editorial header */}
        <header className="grid grid-cols-1 md:grid-cols-12 gap-5 md:gap-8 items-end mb-7 md:mb-9">
          <div className="md:col-span-7">
            <p className="ui-eyebrow text-muted-foreground mb-2.5">
              {t(
                "session.worldsHeaderEyebrow",
                `${worlds.length} worlds available`,
                {
                  count: worlds.length,
                },
              )}
            </p>
            <h1 className="font-display font-bold tracking-tight leading-[0.95] text-[clamp(2.25rem,5.4vw,4.25rem)]">
              {t("session.selectWorld", "Choose a world")}
            </h1>
            <p className="mt-4 text-sm md:text-base text-muted-foreground font-light leading-relaxed max-w-xl">
              {t(
                "session.worldSelectDesc",
                "Each world is a self-contained setting with its own tone, characters, and ruleset.",
              )}
            </p>
          </div>

          {/* Compact action rail keeps creation and setup nearby without pushing worlds down. */}
          <aside className="md:col-span-5 grid grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onOpenGenerator}
              className="group relative min-h-[92px] overflow-hidden rounded-[var(--radius-card)] border border-primary/25 bg-card/80 hover:border-primary/55 transition-all p-3 sm:p-4 text-left"
            >
              <div
                aria-hidden="true"
                className="absolute -right-12 -top-12 h-28 w-28 rounded-full opacity-40 group-hover:opacity-65 transition-opacity"
                style={{
                  background:
                    "radial-gradient(circle, color-mix(in oklab, var(--color-primary) 70%, transparent) 0%, transparent 70%)",
                }}
              />
              <div className="relative">
                <div className="flex items-center gap-2 mb-2">
                  <Wand2 className="w-4 h-4 text-primary" />
                  <span className="ui-eyebrow text-primary">
                    {t("world.aiCreate", "AI generate")}
                  </span>
                </div>
                <p className="font-display text-[13px] sm:text-sm font-semibold leading-snug line-clamp-2">
                  {t(
                    "session.aiCreateTeaser",
                    "Spin up a brand new world from a one-line idea.",
                  )}
                </p>
                <p className="mt-3 text-xs text-primary inline-flex items-center gap-1.5 group-hover:gap-2.5 transition-all font-medium">
                  {t("session.aiCreateAction", "Describe your idea")}
                  <ArrowRight className="w-3.5 h-3.5" />
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={onOpenSettings}
              className="group flex min-h-[92px] items-center justify-between rounded-[var(--radius-card)] border border-border bg-card/70 hover:border-primary/40 hover:bg-muted/30 transition-all p-3 sm:p-4 text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-[13px] sm:text-sm font-medium leading-snug line-clamp-2">
                    {t("session.configureKeys", "API keys & presets")}
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 truncate">
                    {primarySlotLabel ??
                      t("session.noModelsConfigured", "No model configured")}
                  </p>
                </div>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
            </button>
          </aside>
        </header>

        {/* World list — cover-led plates with the same action surface. */}
        {worlds.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-5">
            {worlds.map((world, index) => {
              const isEntering = enteringWorldId === world.id;
              const dimmed = enteringWorldId !== null && !isEntering;
              return (
                <WorldCard
                  key={world.id}
                  world={world}
                  index={index}
                  isEntering={isEntering}
                  dimmed={dimmed}
                  storageLabel={storageLabel(world)}
                  t={t}
                  onEnter={onEnterWorld}
                  onViewDetails={onViewDetails}
                  onDelete={onDeleteWorld}
                />
              );
            })}
          </div>
        )}

        {worlds.length === 0 && (
          <div className="text-center py-16 md:py-24 border-y border-dashed border-[var(--rule-color)]">
            <FolderOpen className="w-10 h-10 mx-auto text-muted-foreground/60" />
            <h2 className="font-display font-bold text-xl mt-5">
              {t("session.worldsEmptyTitle", "No worlds yet")}
            </h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto font-light">
              {t(
                "session.worldsEmptyDesc",
                "Generate a new world with AI, or add a world package under the worlds/ folder.",
              )}
            </p>
            <div className="flex items-center justify-center gap-3 mt-7">
              <Button
                size="sm"
                className="text-xs uppercase tracking-widest"
                onClick={onOpenGenerator}
              >
                <Wand2 className="w-3.5 h-3.5 mr-1.5" />
                {t("world.aiCreate", "AI create")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs uppercase tracking-widest"
                onClick={() =>
                  window.open(
                    "https://github.com/ackness/covel/tree/main/worlds",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                {t("session.worldsEmptyViewExamples", "View examples")}
              </Button>
            </div>
          </div>
        )}

        {/* Footer info chips */}
        <div className="mt-8 md:mt-10 pt-5 border-t border-border flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          {enabledPluginCount > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="w-3 h-3" />
              {t("session.pluginsLoaded", { count: enabledPluginCount })}
            </span>
          )}
          {primarySlotLabel && (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" />
              {primarySlotLabel}
            </span>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
