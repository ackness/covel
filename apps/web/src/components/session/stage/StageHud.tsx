/**
 * HUD overlay for stage mode (spec §2 `StageHud`). Stateless: everything
 * it shows comes from `sceneCurrent` (scene-stage `stage/current`) and
 * every button forwards straight to a prop callback.
 */
import {
  BookOpen,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Moon,
  Pause,
  Play,
  Sun,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import type { StageCurrentRecord } from "./stage-selectors.js";

export interface StageHudProps {
  readonly sceneCurrent: StageCurrentRecord | null | undefined;
  readonly locale: string;
  readonly autoPlay: boolean;
  readonly immersive: boolean;
  readonly onOpenHistory: () => void;
  readonly onToggleAutoPlay: () => void;
  readonly onToggleImmersive: () => void;
  readonly onExit: () => void;
}

export function StageHud({
  sceneCurrent,
  locale,
  autoPlay,
  immersive,
  onOpenHistory,
  onToggleAutoPlay,
  onToggleImmersive,
  onExit,
}: StageHudProps): ReactElement {
  const { t } = useTranslation();
  const isPending = sceneCurrent?.source === "pending";
  const isNight = sceneCurrent?.variant === "night";
  const sourceLabel = sceneCurrent?.sourceLabel;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3 md:p-4"
      data-testid="stage-hud"
    >
      {/* Always render both flex children (even empty) so `justify-between`
          keeps the button group pinned to the right when there's no badge. */}
      <div>
        {sceneCurrent?.name && (
          <div
            className={clsx(
              "ui-stage-panel pointer-events-auto flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs",
              isPending && "ui-pulse-dot",
            )}
          >
            {isNight ? (
              <Moon className="h-3.5 w-3.5" />
            ) : (
              <Sun className="h-3.5 w-3.5" />
            )}
            <span className="font-medium">{sceneCurrent.name}</span>
            {sourceLabel != null && (
              <span className="text-muted-foreground">
                {resolveI18n(sourceLabel, locale)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="ui-stage-panel pointer-events-auto flex items-center gap-1 rounded-[var(--radius-control)] p-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenHistory}
          aria-label={t("stage.historyLabel")}
          title={t("stage.historyLabel")}
        >
          <BookOpen className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleAutoPlay}
          aria-pressed={autoPlay}
          // Ghost buttons have no pressed background, so when auto-play is on
          // only the Play→Pause icon swap signals it. Tint the button accent
          // while active so the on-state reads at a glance.
          className={clsx(autoPlay && "text-[var(--accent-primary)]")}
          aria-label={t(
            autoPlay ? "stage.autoPlayPauseLabel" : "stage.autoPlayLabel",
          )}
          title={t(
            autoPlay ? "stage.autoPlayPauseLabel" : "stage.autoPlayLabel",
          )}
        >
          {autoPlay ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleImmersive}
          aria-pressed={immersive}
          className={clsx(immersive && "text-[var(--accent-primary)]")}
          aria-label={t(
            immersive ? "stage.immersiveExitLabel" : "stage.immersiveLabel",
          )}
          title={t(
            immersive ? "stage.immersiveExitLabel" : "stage.immersiveLabel",
          )}
          data-testid="stage-immersive-toggle"
        >
          {immersive ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onExit}
          aria-label={t("stage.exitLabel")}
          title={t("stage.exitLabel")}
        >
          <MessagesSquare className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
