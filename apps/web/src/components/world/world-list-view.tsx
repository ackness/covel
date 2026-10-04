import type { TFunction } from "i18next";
import { useState } from "react";
import {
  Sparkles,
  Settings,
  Plug,
  Cpu,
  Wand2,
  FolderOpen,
  ArrowRight,
  BookOpen,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { WorldCard } from "@/components/world/world-card.js";
import {
  WorldContinueBanner,
  WorldRowItem,
  WorldTileCard,
} from "@/components/world/world-list-variants.js";
import { WorldShowcase } from "@/components/world/world-showcase.js";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";
import { matchesWorldQuery } from "@/components/world/editor-helpers.js";
import { mostRecentSession } from "@/components/world/use-recent-sessions.js";

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
  interfaceLocale: string;
  onOpenGenerator: () => void;
  /** Opens Settings at the providers and models page. */
  onOpenSettings: () => void;
  /** Opens Settings at its first page. */
  onOpenAllSettings?: () => void;
  onOpenOnboarding?: () => void;
  onEnterWorld: (worldId: string) => void;
  /** Latest playable session per world id; empty when "continue" is off. */
  recentSessions?: ReadonlyMap<string, SessionRecord>;
  onResumeSession?: (session: SessionRecord) => void;
  onViewDetails: (e: React.MouseEvent, worldId: string) => void;
  onDeleteWorld: (e: React.MouseEvent, worldId: string) => void;
}

/**
 * The list-mode body of the world-select screen: editorial header, the
 * AI-generate / API-keys action rail, the cover-led world grid, the empty
 * state, and the footer info chips.
 */
/** One row of the header's action frame: icon block, title, one line of context. */
function HeaderAction({
  icon: Icon,
  title,
  detail,
  accent = false,
  warn = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  /** The page's main action takes the theme accent. */
  accent?: boolean;
  /** The detail reports something the player has to fix. */
  warn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-foreground)_4%,transparent)]"
    >
      <span
        className={
          "flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) " +
          (accent
            ? "bg-[color-mix(in_oklab,var(--accent-primary)_16%,transparent)] text-(--accent-primary)"
            : "bg-[color-mix(in_oklab,var(--color-foreground)_7%,transparent)] text-muted-foreground")
        }
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug">{title}</span>
        <span
          className={
            "mt-0.5 line-clamp-2 block text-xs leading-snug " +
            (warn ? "text-(--accent-warning)" : "text-muted-foreground")
          }
        >
          {detail}
        </span>
      </span>
      <ArrowRight
        className="size-3.5 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-(--accent-primary)"
        aria-hidden
      />
    </button>
  );
}

export function WorldListView(props: WorldListViewProps) {
  const {
    worlds,
    t,
    primarySlotLabel,
    enabledPluginCount,
    enteringWorldId,
    storageLabel,
    interfaceLocale,
    onOpenGenerator,
    onOpenSettings,
    onOpenAllSettings,
    onOpenOnboarding,
    onEnterWorld,
    recentSessions,
    onResumeSession,
    onViewDetails,
    onDeleteWorld,
  } = props;
  const { worldList } = useThemeLayout();
  const [query, setQuery] = useState("");
  const visibleWorlds = worlds.filter((world) =>
    matchesWorldQuery(world, query),
  );
  const continueSession =
    worldList === "cards" && recentSessions && onResumeSession
      ? mostRecentSession(recentSessions)
      : undefined;
  const continueWorld = continueSession
    ? worlds.find((world) => world.id === continueSession.worldId)
    : undefined;
  // The showcase needs a world to feature; with none, the plain list carries
  // the empty state and the create actions.
  if (worldList === "showcase" && worlds.length > 0) {
    return <WorldShowcase {...props} />;
  }
  const WorldItem =
    worldList === "list"
      ? WorldRowItem
      : worldList === "cards"
        ? WorldTileCard
        : WorldCard;
  const listClassName =
    worldList === "list"
      ? "flex flex-col border-b border-(--rule-color)"
      : worldList === "cards"
        ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        : "grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5";

  return (
    <div className="ui-world-select h-full w-full overflow-y-auto overscroll-contain">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-5 md:py-8">
        {/* Editorial header */}
        <header className="ui-drag-region grid grid-cols-1 md:grid-cols-12 gap-5 md:gap-8 items-end mb-7 md:mb-9">
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
            <h1 className="ui-world-heading font-display font-bold tracking-tight leading-[0.95] text-[clamp(2.25rem,5.4vw,4.25rem)]">
              {t("session.selectWorld", "Choose a world")}
            </h1>
            <p className="mt-4 text-sm md:text-base text-muted-foreground font-light leading-relaxed max-w-xl">
              {t(
                "session.worldSelectDesc",
                "Each world is a self-contained setting with its own tone, characters, and ruleset.",
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
              {onOpenOnboarding && (
                <Button
                  variant="link"
                  className="h-auto px-0 py-1.5"
                  onClick={onOpenOnboarding}
                >
                  <BookOpen className="h-4 w-4" aria-hidden />
                  {t("onboarding.guide")}
                </Button>
              )}
              {onOpenAllSettings && (
                <Button
                  variant="link"
                  className="h-auto px-0 py-1.5"
                  onClick={onOpenAllSettings}
                >
                  <Settings className="h-4 w-4" aria-hidden />
                  {t("nav.settings", "Settings")}
                </Button>
              )}
            </div>
          </div>

          {/* Two actions in one frame: each row has room for its full text. */}
          <aside className="divide-y divide-(--rule-color) overflow-hidden rounded-(--radius-card) border border-(--rule-color) bg-card/60 md:col-span-5">
            <HeaderAction
              icon={Wand2}
              accent
              title={t("world.aiCreate", "AI generate")}
              detail={t(
                "session.aiCreateTeaser",
                "Spin up a brand new world from a one-line idea.",
              )}
              onClick={onOpenGenerator}
            />
            <HeaderAction
              icon={Plug}
              title={t("session.configureKeys", "API keys & presets")}
              detail={
                primarySlotLabel ??
                t("session.noModelsConfigured", "No model configured")
              }
              warn={!primarySlotLabel}
              onClick={onOpenSettings}
            />
          </aside>
        </header>

        {/* World list — cover-led plates with the same action surface. */}
        {continueSession && continueWorld && onResumeSession && (
          <WorldContinueBanner
            world={continueWorld}
            recentSession={continueSession}
            disabled={enteringWorldId !== null}
            t={t}
            onResume={onResumeSession}
          />
        )}

        {worldList === "cards" && worlds.length > 0 && (
          <label className="ui-world-search mb-4 flex h-10 w-full max-w-xs items-center gap-2 rounded-(--radius-control) border border-border bg-card px-3 text-muted-foreground">
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="sr-only">{t("session.searchWorlds")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("session.searchWorlds")}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        )}

        {worlds.length > 0 && (
          <div className={listClassName}>
            {visibleWorlds.map((world, index) => {
              const isEntering = enteringWorldId === world.id;
              const dimmed = enteringWorldId !== null && !isEntering;
              return (
                <WorldItem
                  key={world.id}
                  world={world}
                  index={index}
                  isEntering={isEntering}
                  dimmed={dimmed}
                  storageLabel={storageLabel(world)}
                  interfaceLocale={interfaceLocale}
                  t={t}
                  onEnter={onEnterWorld}
                  onViewDetails={onViewDetails}
                  onDelete={onDeleteWorld}
                  recentSession={recentSessions?.get(world.id)}
                  onResume={onResumeSession}
                />
              );
            })}
          </div>
        )}

        {worlds.length > 0 && visibleWorlds.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("session.searchWorldsEmpty")}
          </p>
        )}

        {worlds.length === 0 && (
          <div className="text-center py-16 md:py-24 border-y border-dashed border-(--rule-color)">
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
    </div>
  );
}
