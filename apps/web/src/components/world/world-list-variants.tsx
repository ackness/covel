import { useState, type CSSProperties } from "react";
import { ArrowRight, Eye, Play, Trash2 } from "lucide-react";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { sessionContinueLabel } from "@/lib/session-display.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { packageByline, worldPackageInfo } from "@/lib/package-info.js";
import { worldLanguageBadge, worldLanguageName } from "@/lib/world-locale.js";
import { isWorldDeletable } from "./world-deletion.js";
import type { WorldCardProps } from "./world-card.js";
import {
  ShowcaseBackdrop,
  WorldCardCover,
  WorldGalleryLightbox,
  WorldGalleryStrip,
  useSlideshow,
  useWorldArt,
} from "./world-gallery.js";

/**
 * World-select arrangements other than the classic cover grid. Which one
 * renders is the active theme package's `layout.worldList`; all of them drive
 * the same enter / details / delete handlers as `WorldCard`. The `showcase`
 * arrangement is in `world-showcase.tsx`.
 */

/**
 * A world's primary action. With a playable session it continues that session
 * and a quieter "enter" keeps the way to a fresh start; without one, entering
 * is the primary action.
 */
export function WorldPrimaryActions({
  world,
  recentSession,
  onResume,
  onEnter,
  disabled,
  busy,
  t,
  size,
}: {
  readonly world: WorldRecord;
  readonly recentSession?: SessionRecord;
  readonly onResume?: (session: SessionRecord) => void;
  readonly onEnter: (worldId: string) => void;
  readonly disabled: boolean;
  readonly busy?: boolean;
  readonly t: WorldCardProps["t"];
  readonly size: "sm" | "md" | "lg";
}) {
  const sizing =
    size === "lg"
      ? "h-12 px-6 text-[15px] font-semibold"
      : size === "md"
        ? "h-10 px-4 md:h-9"
        : "h-10 px-4 md:h-8.5";
  const iconSize = size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5";
  const resumable = recentSession && onResume ? recentSession : undefined;
  // The session list arrives after the first paint. The keys keep "enter" the
  // same element when "continue" appears before it, so a click already aimed
  // at "enter" cannot land on a button that now continues a session.
  return (
    <>
      {resumable && onResume && (
        <button
          key="continue"
          type="button"
          onClick={() => onResume(resumable)}
          disabled={disabled}
          aria-busy={busy}
          className={`ui-btn ui-world-enter ${sizing}`}
        >
          <Play className={iconSize} />
          {sessionContinueLabel(t, resumable.completedPlayerTurns)}
        </button>
      )}
      <button
        key="enter"
        type="button"
        onClick={() => onEnter(world.id)}
        disabled={disabled}
        aria-busy={resumable ? undefined : busy}
        className={
          resumable
            ? `ui-btn ${size === "lg" ? "ui-world-glass h-12 px-5 text-[15px]" : `ui-btn-quiet text-muted-foreground ${sizing}`}`
            : `ui-btn ui-world-enter ${sizing}`
        }
      >
        {t("session.enter", "Enter")}
        {!resumable && <ArrowRight className={iconSize} />}
      </button>
    </>
  );
}

export function accentStyle(
  accent: string,
  extra?: CSSProperties,
): CSSProperties {
  return { "--world-accent": accent, ...extra } as CSSProperties;
}

/** `cards` — cover on top, copy and actions on a plain surface below. */
export function WorldTileCard({
  world,
  index,
  isEntering,
  dimmed,
  interfaceLocale,
  t,
  onEnter,
  onViewDetails,
  onDelete,
  recentSession,
  onResume,
}: WorldCardProps) {
  const visual = worldVisual(world);
  const languageBadge = worldLanguageBadge(world.locale);
  const languageName = worldLanguageName(world.locale, interfaceLocale);
  const tags = world.tags ?? [];
  const byline = packageByline(worldPackageInfo(world), t);
  return (
    <article
      aria-busy={isEntering}
      className={`ui-world-tile group flex flex-col overflow-hidden rounded-(--radius-card) border border-border bg-card transition-colors hover:border-(--rule-strong-color) ${
        dimmed ? "opacity-30 pointer-events-none" : ""
      }`}
      style={accentStyle(visual.accent)}
    >
      <WorldCardCover
        world={world}
        title={text(world.name)}
        cover={visual.image}
        eager={index < 3}
        className="h-40"
        t={t}
      >
        {languageBadge && languageName && (
          <span
            className="ui-tag absolute right-3 top-3 border-white/25 bg-black/45 text-white/90 backdrop-blur-sm"
            title={t("world.languageLabel", {
              language: languageName,
              defaultValue: "World language: {{language}}",
            })}
          >
            {languageBadge}
          </span>
        )}
      </WorldCardCover>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <h2 className="ui-title text-lg leading-snug">{text(world.name)}</h2>
        <p className="flex-1 text-[13px] leading-relaxed text-muted-foreground line-clamp-3 wrap-break-word">
          {text(world.description)}
        </p>
        {byline && (
          <p className="truncate text-xs text-muted-foreground">{byline}</p>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.slice(0, 4).map((tag) => (
              <span key={tag} className="ui-world-tag">
                {tag}
              </span>
            ))}
            {tags.length > 4 && (
              <span className="ui-world-tag">+{tags.length - 4}</span>
            )}
          </div>
        )}
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => onViewDetails(e, world.id)}
              aria-label={t("world.viewDetails", "View Details")}
              title={t("world.viewDetails", "View Details")}
              className="ui-btn ui-btn-quiet h-10 w-10 p-0 text-muted-foreground md:h-8 md:w-8"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            {isWorldDeletable(world) && (
              <button
                type="button"
                onClick={(e) => onDelete(e, world.id)}
                aria-label={t("world.delete", "Delete world")}
                className="ui-btn ui-btn-quiet h-10 gap-1.5 px-2.5 text-muted-foreground hover:text-(--accent-danger) md:h-8"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="text-xs">
                  {t("world.delete", "Delete world")}
                </span>
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <WorldPrimaryActions
              world={world}
              recentSession={recentSession}
              onResume={onResume}
              onEnter={onEnter}
              disabled={dimmed}
              t={t}
              size="sm"
            />
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * The world of the latest session above the `cards` grid: its scenes rotate
 * beside the title, and its pictures sit above the button that continues.
 */
export function WorldContinueBanner({
  world,
  recentSession,
  disabled,
  t,
  onResume,
}: Pick<WorldCardProps, "world" | "t"> & {
  readonly recentSession: NonNullable<WorldCardProps["recentSession"]>;
  readonly disabled: boolean;
  readonly onResume: NonNullable<WorldCardProps["onResume"]>;
}) {
  const { slides, pictures } = useWorldArt(world, worldVisual(world).image);
  const slideshow = useSlideshow(world.id, slides.length);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section
      aria-label={t("session.continueLatest")}
      className="ui-world-continue mb-6 flex flex-wrap overflow-hidden rounded-(--radius-card) border border-border bg-card"
    >
      <div className="relative min-h-44 min-w-0 flex-[1_1_22rem] overflow-hidden">
        <ShowcaseBackdrop slides={slides} index={slideshow.index} />
      </div>
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col justify-center gap-2.5 px-6 py-5">
        <span className="text-xs font-semibold text-(--accent-primary)">
          {t("session.continueLatest")}
        </span>
        <h2 className="ui-title text-2xl leading-snug">{text(world.name)}</h2>
        <WorldGalleryStrip
          items={pictures}
          limit={5}
          surface
          onOpen={setOpen}
          t={t}
        />
        <div className="pt-1">
          <button
            type="button"
            onClick={() => onResume(recentSession)}
            disabled={disabled}
            className="ui-btn ui-world-enter h-10 px-4"
          >
            <Play className="h-3.5 w-3.5" />
            {sessionContinueLabel(t, recentSession.completedPlayerTurns)}
          </button>
        </div>
      </div>
      <WorldGalleryLightbox
        items={pictures}
        index={open}
        title={text(world.name)}
        onIndexChange={setOpen}
        t={t}
      />
    </section>
  );
}

/** `list` — one world per row, read like a table of contents. */
export function WorldRowItem({
  world,
  index,
  isEntering,
  dimmed,
  interfaceLocale,
  t,
  onEnter,
  onViewDetails,
  onDelete,
  recentSession,
  onResume,
}: WorldCardProps) {
  const visual = worldVisual(world);
  const languageName = worldLanguageName(world.locale, interfaceLocale);
  const meta = [
    ...(world.tags ?? []).slice(0, 5),
    languageName,
    packageByline(worldPackageInfo(world), t),
  ].filter((part): part is string => Boolean(part));
  return (
    <article
      aria-busy={isEntering}
      className={`ui-world-row grid grid-cols-1 items-center gap-x-7 gap-y-4 border-t border-(--rule-color) py-5 md:grid-cols-[3rem_minmax(0,1fr)_19rem] ${
        dimmed ? "opacity-30 pointer-events-none" : ""
      }`}
      style={accentStyle(visual.accent)}
    >
      <span
        aria-hidden="true"
        className="ui-world-row-index ui-title hidden text-3xl tabular-nums text-(--accent-primary) md:block"
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="min-w-0 space-y-2">
        <h2 className="ui-title text-2xl leading-snug">{text(world.name)}</h2>
        <p className="max-w-xl text-[14.5px] leading-[1.75] text-muted-foreground line-clamp-3 wrap-break-word">
          {text(world.description)}
        </p>
        {meta.length > 0 && (
          <p className="text-[13px] text-muted-foreground">
            {meta.join(" · ")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <WorldPrimaryActions
            world={world}
            recentSession={recentSession}
            onResume={onResume}
            onEnter={onEnter}
            disabled={dimmed}
            t={t}
            size="md"
          />
          <button
            type="button"
            onClick={(e) => onViewDetails(e, world.id)}
            className="ui-btn ui-btn-quiet h-10 px-3 text-muted-foreground md:h-9"
          >
            <Eye className="h-3.5 w-3.5" />
            {t("world.viewDetails", "View Details")}
          </button>
          {isWorldDeletable(world) && (
            <button
              type="button"
              onClick={(e) => onDelete(e, world.id)}
              aria-label={t("world.delete", "Delete world")}
              className="ui-btn ui-btn-quiet h-10 px-3 text-muted-foreground hover:text-(--accent-danger) md:h-9"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("world.delete", "Delete world")}
            </button>
          )}
        </div>
      </div>
      <img
        src={visual.image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        loading={index < 3 ? "eager" : "lazy"}
        className="h-32 w-full rounded-(--radius-card) object-cover"
        draggable={false}
      />
    </article>
  );
}
