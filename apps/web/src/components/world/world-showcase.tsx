import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  LayoutGrid,
  Plug,
  Search,
  Settings,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { WorldRecord } from "@/services/api.js";
import { matchesWorldQuery, text } from "@/components/world/editor-helpers.js";
import { useOverflowEdges } from "@/hooks/use-overflow-edges.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { packageByline, worldPackageInfo } from "@/lib/package-info.js";
import { worldLanguageName } from "@/lib/world-locale.js";
import { isWorldDeletable } from "./world-deletion.js";
import {
  ShowcaseBackdrop,
  SlideIndicator,
  WorldGalleryLightbox,
  WorldGalleryStrip,
  useSlideshow,
  useWorldArt,
} from "./world-gallery.js";
import { WorldPrimaryActions, accentStyle } from "./world-list-variants.js";
import type { WorldListViewProps } from "./world-list-view.js";
import { mostRecentSession } from "./use-recent-sessions.js";

type Translate = WorldListViewProps["t"];

/** Every world as a searchable grid, for a list too long for the strip. */
function AllWorldsDialog({
  worlds,
  selectedId,
  open,
  onOpenChange,
  onSelect,
  t,
}: {
  readonly worlds: readonly WorldRecord[];
  readonly selectedId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (worldId: string) => void;
  readonly t: Translate;
}) {
  const [query, setQuery] = useState("");
  const visible = worlds.filter((world) => matchesWorldQuery(world, query));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("session.allWorlds", { total: worlds.length })}
          </DialogTitle>
        </DialogHeader>
        <label className="flex h-10 items-center gap-2 rounded-(--radius-control) border border-border bg-card px-3 text-muted-foreground">
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
        <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto overscroll-contain sm:grid-cols-3">
          {visible.map((world) => (
            <button
              key={world.id}
              type="button"
              aria-pressed={world.id === selectedId}
              onClick={() => {
                onSelect(world.id);
                onOpenChange(false);
              }}
              className="group overflow-hidden rounded-(--radius-card) border border-border bg-card text-left transition-colors hover:border-(--rule-strong-color) aria-pressed:border-(--accent-primary)"
            >
              <img
                src={worldVisual(world).image}
                alt=""
                aria-hidden="true"
                loading="lazy"
                className="h-24 w-full object-cover"
                draggable={false}
              />
              <span className="block px-3 py-2">
                <span className="ui-title line-clamp-1 block text-sm">
                  {text(world.name)}
                </span>
                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                  {(world.tags ?? []).slice(0, 3).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
        {visible.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("session.searchWorldsEmpty")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The strip of world covers. Any number of worlds stays one row: what does not
 * fit scrolls, with the cut-off edge faded, and the row above the strip then
 * offers steps to either side and the full list.
 */
function WorldRail({
  worlds,
  selectedId,
  busy,
  leading,
  onSelect,
  t,
}: {
  readonly worlds: readonly WorldRecord[];
  readonly selectedId: string;
  readonly busy: boolean;
  /** Controls that share the row above the strip. */
  readonly leading: ReactNode;
  readonly onSelect: (worldId: string) => void;
  readonly t: Translate;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(railRef, worlds.length);
  const overflowing = edges.start || edges.end;
  const [browsing, setBrowsing] = useState(false);

  // Scrolls the strip only: the page keeps its place.
  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !active) return;
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;
    if (start < rail.scrollLeft)
      rail.scrollTo?.({ left: start - 40, behavior: "smooth" });
    else if (end > rail.scrollLeft + rail.clientWidth)
      rail.scrollTo?.({
        left: end - rail.clientWidth + 40,
        behavior: "smooth",
      });
  }, [selectedId]);

  const step = (direction: 1 | -1) => {
    const rail = railRef.current;
    rail?.scrollBy?.({
      left: direction * rail.clientWidth * 0.8,
      behavior: "smooth",
    });
  };

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-3">
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
        {leading}
        {overflowing && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={!edges.start}
              aria-label={t("session.worldsScrollBack")}
              title={t("session.worldsScrollBack")}
              className="ui-btn ui-world-glass size-9 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={!edges.end}
              aria-label={t("session.worldsScrollForward")}
              title={t("session.worldsScrollForward")}
              className="ui-btn ui-world-glass size-9 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="ui-btn ui-world-glass h-9 px-3"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              {t("session.allWorlds", { total: worlds.length })}
            </button>
          </>
        )}
      </div>
      {worlds.length > 1 && (
        <div
          ref={railRef}
          data-fade-start={edges.start}
          data-fade-end={edges.end}
          className="ui-scroll-fade ui-world-rail relative flex max-w-full items-end gap-3.5 overflow-x-auto pb-1"
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0;
            const next =
              worlds[
                worlds.findIndex((world) => world.id === selectedId) + delta
              ];
            if (!delta || !next || busy) return;
            event.preventDefault();
            onSelect(next.id);
            event.currentTarget
              .querySelector<HTMLElement>(
                `[data-world-id="${CSS.escape(next.id)}"]`,
              )
              ?.focus();
          }}
        >
          {worlds.map((world) => {
            const active = world.id === selectedId;
            return (
              <button
                key={world.id}
                type="button"
                data-world-id={world.id}
                onClick={() => onSelect(world.id)}
                aria-pressed={active}
                disabled={busy}
                className={`ui-world-thumb relative w-40 shrink-0 overflow-hidden rounded-(--radius-card) text-left transition-all ${
                  active ? "h-60" : "h-52"
                }`}
              >
                <img
                  src={worldVisual(world).image}
                  alt=""
                  aria-hidden="true"
                  width={1536}
                  height={1024}
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover"
                  draggable={false}
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-28 bg-linear-to-t from-black/90 to-transparent"
                />
                <span className="ui-title absolute inset-x-3 bottom-3 text-base leading-snug text-white">
                  {text(world.name)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <AllWorldsDialog
        worlds={worlds}
        selectedId={selectedId}
        open={browsing}
        onOpenChange={setBrowsing}
        onSelect={onSelect}
        t={t}
      />
    </div>
  );
}

/**
 * `showcase` — the selected world fills the screen: its cover and scenes
 * rotate behind the title and actions, its portraits sit under the summary,
 * and the other worlds wait in a strip of covers. Text is white on a dark
 * scrim in either colour scheme, as on the cover cards.
 */
export function WorldShowcase({
  worlds,
  t,
  primarySlotLabel,
  enteringWorldId,
  interfaceLocale,
  onOpenGenerator,
  onOpenSettings,
  onOpenAllSettings,
  onEnterWorld,
  recentSessions,
  onResumeSession,
  onViewDetails,
  onDeleteWorld,
}: WorldListViewProps) {
  // Until the player picks a thumbnail, feature the world they last played.
  const [pickedId, setSelectedId] = useState<string | undefined>();
  const [openImage, setOpenImage] = useState<number | null>(null);
  const selectedId =
    pickedId ??
    (recentSessions ? mostRecentSession(recentSessions)?.worldId : undefined);
  const selected = worlds.find((world) => world.id === selectedId) ?? worlds[0];
  const { slides, pictures } = useWorldArt(
    selected,
    worldVisual(selected).image,
  );
  const slideshow = useSlideshow(selected?.id ?? "", slides.length);
  if (!selected) return null;
  const resumable = Boolean(
    recentSessions?.get(selected.id) && onResumeSession,
  );
  const visual = worldVisual(selected);
  const languageName = worldLanguageName(selected.locale, interfaceLocale);
  const busy = enteringWorldId !== null;
  const tags = selected.tags ?? [];
  const byline = packageByline(worldPackageInfo(selected), t);
  const select = (worldId: string) => {
    setOpenImage(null);
    setSelectedId(worldId);
  };

  return (
    <div
      className="ui-world-showcase relative h-full w-full overflow-y-auto overscroll-contain bg-black text-white"
      style={accentStyle(visual.accent)}
    >
      <ShowcaseBackdrop slides={slides} index={slideshow.index} />
      <div aria-hidden="true" className="ui-world-showcase-scrim" />

      <div className="relative z-1 flex min-h-full flex-col">
        <div className="ui-drag-region flex flex-wrap items-center justify-end gap-2 px-5 pt-5 md:px-8">
          <button
            type="button"
            onClick={onOpenGenerator}
            className="ui-btn ui-world-glass h-10 px-3.5"
          >
            <Wand2 className="h-3.5 w-3.5" />
            {t("world.aiCreate", "AI generate")}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="ui-btn ui-world-glass h-10 px-3.5"
            title={primarySlotLabel ?? undefined}
          >
            <Plug className="h-3.5 w-3.5" />
            {t("session.configureKeys", "API keys & presets")}
          </button>
          {onOpenAllSettings && (
            <button
              type="button"
              onClick={onOpenAllSettings}
              className="ui-btn ui-world-glass h-10 px-3.5"
            >
              <Settings className="h-3.5 w-3.5" />
              {t("nav.settings", "Settings")}
            </button>
          )}
        </div>

        <div className="min-h-10 flex-1" />

        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-8 px-5 pb-8 md:px-12 md:pb-11">
          <div className="max-w-xl flex-[1_1_24rem] space-y-3.5">
            <p className="ui-eyebrow text-(--accent-primary)">
              {resumable
                ? t("session.continueLatest")
                : t(
                    "session.worldsHeaderEyebrow",
                    `${worlds.length} worlds available`,
                    { count: worlds.length },
                  )}
            </p>
            <h1 className="ui-title text-5xl leading-[1.1] md:text-6xl">
              {text(selected.name)}
            </h1>
            <p className="text-base leading-[1.8] text-white/88 line-clamp-4 wrap-break-word">
              {text(selected.description)}
            </p>
            {byline && (
              <p className="truncate text-[13px] text-white/72">{byline}</p>
            )}
            {(tags.length > 0 || languageName) && (
              <div className="flex flex-wrap gap-2">
                {tags.slice(0, 5).map((tag) => (
                  <span key={tag} className="ui-world-chip">
                    {tag}
                  </span>
                ))}
                {languageName && (
                  <span className="ui-world-chip">{languageName}</span>
                )}
              </div>
            )}
            <WorldGalleryStrip
              items={pictures}
              limit={6}
              onOpen={setOpenImage}
              t={t}
            />
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <WorldPrimaryActions
                world={selected}
                recentSession={recentSessions?.get(selected.id)}
                onResume={onResumeSession}
                onEnter={onEnterWorld}
                disabled={busy}
                busy={enteringWorldId === selected.id}
                t={t}
                size="lg"
              />
              <button
                type="button"
                onClick={(e) => onViewDetails(e, selected.id)}
                className="ui-btn ui-world-glass h-12 px-5 text-[15px]"
              >
                <Eye className="h-4 w-4" />
                {t("world.viewDetails", "View details")}
              </button>
              {isWorldDeletable(selected) && (
                <button
                  type="button"
                  onClick={(e) => onDeleteWorld(e, selected.id)}
                  aria-label={t("world.delete", "Delete world")}
                  className="ui-btn ui-world-glass h-12 px-5 text-[15px]"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("world.delete", "Delete world")}
                </button>
              )}
            </div>
          </div>

          {(worlds.length > 1 || slides.length > 1) && (
            <WorldRail
              worlds={worlds}
              selectedId={selected.id}
              busy={busy}
              leading={
                <SlideIndicator
                  count={slides.length}
                  slideshow={slideshow}
                  t={t}
                />
              }
              onSelect={select}
              t={t}
            />
          )}
        </div>
      </div>

      <WorldGalleryLightbox
        items={pictures}
        index={openImage}
        title={text(selected.name)}
        onIndexChange={setOpenImage}
        t={t}
      />
    </div>
  );
}
