import { useState, type CSSProperties } from "react";
import { ArrowRight, Eye, KeyRound, Play, Trash2, Wand2 } from "lucide-react";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { sessionContinueLabel } from "@/lib/session-display.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { worldLanguageBadge, worldLanguageName } from "@/lib/world-locale.js";
import { isWorldDeletable } from "./world-deletion.js";
import type { WorldCardProps } from "./world-card.js";
import type { WorldListViewProps } from "./world-list-view.js";
import { mostRecentSession } from "./use-recent-sessions.js";

/**
 * World-select arrangements other than the classic cover grid. Which one
 * renders is the active theme package's `layout.worldList`; all of them drive
 * the same enter / details / delete handlers as `WorldCard`.
 */

/**
 * A world's primary action. With a playable session it continues that session
 * and a quieter "enter" keeps the way to a fresh start; without one, entering
 * is the primary action.
 */
function WorldPrimaryActions({
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
  if (recentSession && onResume) {
    return (
      <>
        <button
          type="button"
          onClick={() => onResume(recentSession)}
          disabled={disabled}
          aria-busy={busy}
          className={`ui-btn ui-world-enter ${sizing}`}
        >
          <Play className={iconSize} />
          {sessionContinueLabel(t, recentSession.completedPlayerTurns)}
        </button>
        <button
          type="button"
          onClick={() => onEnter(world.id)}
          disabled={disabled}
          className={`ui-btn ${size === "lg" ? "ui-world-glass h-12 px-5 text-[15px]" : `ui-btn-quiet text-muted-foreground ${sizing}`}`}
        >
          {t("session.enter", "Enter")}
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onEnter(world.id)}
      disabled={disabled}
      aria-busy={busy}
      className={`ui-btn ui-world-enter ${sizing}`}
    >
      {t("session.enter", "Enter")}
      <ArrowRight className={iconSize} />
    </button>
  );
}

function accentStyle(accent: string, extra?: CSSProperties): CSSProperties {
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
  return (
    <article
      aria-busy={isEntering}
      className={`ui-world-tile group flex flex-col overflow-hidden rounded-(--radius-card) border border-border bg-card transition-colors hover:border-(--rule-strong-color) ${
        dimmed ? "opacity-30 pointer-events-none" : ""
      }`}
      style={accentStyle(visual.accent)}
    >
      <div className="relative h-40 overflow-hidden">
        <img
          src={visual.image}
          alt=""
          aria-hidden="true"
          width={1536}
          height={1024}
          loading={index < 3 ? "eager" : "lazy"}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          draggable={false}
        />
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
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <h2 className="ui-title text-lg leading-snug">{text(world.name)}</h2>
        <p className="flex-1 text-[13px] leading-relaxed text-muted-foreground line-clamp-3 wrap-break-word">
          {text(world.description)}
        </p>
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
              aria-label={t("world.viewDetails", "View details")}
              title={t("world.viewDetails", "View details")}
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
  const meta = [...(world.tags ?? []).slice(0, 5), languageName].filter(
    (part): part is string => Boolean(part),
  );
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
            {t("world.viewDetails", "View details")}
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

/**
 * `showcase` — the selected world's cover fills the screen with its title and
 * actions over it; the other worlds sit in a strip of thumbnails. Text is
 * white on a dark scrim in either colour scheme, as on the cover cards.
 */
export function WorldShowcase({
  worlds,
  t,
  primarySlotLabel,
  enteringWorldId,
  interfaceLocale,
  onOpenGenerator,
  onOpenSettings,
  onEnterWorld,
  recentSessions,
  onResumeSession,
  onViewDetails,
  onDeleteWorld,
}: WorldListViewProps) {
  // Until the player picks a thumbnail, feature the world they last played.
  const [pickedId, setSelectedId] = useState<string | undefined>();
  const selectedId =
    pickedId ??
    (recentSessions ? mostRecentSession(recentSessions)?.worldId : undefined);
  const selected = worlds.find((world) => world.id === selectedId) ?? worlds[0];
  if (!selected) return null;
  const resumable = Boolean(
    recentSessions?.get(selected.id) && onResumeSession,
  );
  const visual = worldVisual(selected);
  const languageName = worldLanguageName(selected.locale, interfaceLocale);
  const busy = enteringWorldId !== null;
  const tags = selected.tags ?? [];

  return (
    <div
      className="ui-world-showcase relative h-full w-full overflow-y-auto overscroll-contain bg-black text-white"
      style={accentStyle(visual.accent)}
    >
      <img
        key={selected.id}
        src={visual.image}
        alt=""
        aria-hidden="true"
        width={1536}
        height={1024}
        className="ui-stage-crossfade absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
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
            <KeyRound className="h-3.5 w-3.5" />
            {t("session.configureKeys", "API keys & presets")}
          </button>
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

          {worlds.length > 1 && (
            <div className="flex max-w-full items-end gap-3.5 overflow-x-auto pb-1">
              {worlds.map((world) => {
                const thumb = worldVisual(world);
                const active = world.id === selected.id;
                return (
                  <button
                    key={world.id}
                    type="button"
                    onClick={() => setSelectedId(world.id)}
                    aria-pressed={active}
                    disabled={busy}
                    className={`ui-world-thumb relative w-40 shrink-0 overflow-hidden rounded-(--radius-card) text-left transition-all ${
                      active ? "h-60" : "h-52"
                    }`}
                  >
                    <img
                      src={thumb.image}
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
        </div>
      </div>
    </div>
  );
}
