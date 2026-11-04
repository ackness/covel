import { useRef, type ReactNode } from "react";
import { useNoticeAnchor } from "@/components/ui/notice-host.js";
import {
  ChevronDown,
  ChevronLeft,
  Clock,
  PanelsTopLeft,
  MapPin,
  PanelRight,
} from "lucide-react";
import type { TFunction } from "i18next";
import {
  parsePluginViewMode,
  type PluginViewMode,
  type StageBackdropModel,
} from "@covel/shared";
import type { PluginViewEntry } from "./use-plugin-views.js";
import { Button } from "@/components/ui/button.js";
import { Toggle } from "@/components/ui/toggle.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { worldDisplayText } from "@/lib/world-locale.js";
import { sessionTurnLabel } from "@/lib/session-display.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
import { ConnectionStatus } from "./connection-status.js";
import { NoticeStatusChips } from "./notice-status-chips.js";
import { HeaderMenu, MenuItem } from "./header-menu.js";
import {
  executionTone,
  type ExecutionPresentation,
} from "../execution-presentation.js";

export type GameViewMode =
  "parsed" | "detailed" | "raw" | "stage" | PluginViewMode;

interface GameViewHeaderProps {
  /** The session menu; the header only places it. */
  menu: ReactNode;
  t: TFunction;
  sessionId: string;
  sessionPhase: SessionRecord["phase"];
  locale: SessionRecord["locale"];
  /** Committed player turns, shown beside the world name. */
  turnCount: number;
  world: WorldRecord | null;
  executing: boolean;
  executionState?: ExecutionPresentation;
  recoveryNoticeVisible?: boolean;
  viewMode: GameViewMode;
  pluginViews: readonly PluginViewEntry[];
  /** A plugin page replaced the host input box, so Stop must live here. */
  composerHidden?: boolean;
  /** A turn or auto-advance run is actually in progress. */
  stoppable?: boolean;
  onStop?: () => void;
  isRightCollapsed: boolean;
  onViewModeChange: (mode: GameViewMode) => void;
  onToggleRightPanel: () => void;
  onOpenSuspensions: () => void;
  onBackToWorldSelect: () => void;
  suspensionsCount: number;
}

/**
 * Session toolbar. The left side says where the player is — world, turn,
 * scene, what the story waits for; the right side holds the view switch, the
 * one menu and the side panel. Everything else is in the menu.
 */
export function GameViewHeader({
  menu,
  t,
  sessionId,
  sessionPhase,
  locale,
  turnCount,
  world,
  executing,
  executionState,
  recoveryNoticeVisible = false,
  viewMode,
  pluginViews,
  composerHidden = false,
  stoppable = false,
  onStop,
  isRightCollapsed,
  onViewModeChange,
  onToggleRightPanel,
  onOpenSuspensions,
  onBackToWorldSelect,
  suspensionsCount,
}: GameViewHeaderProps) {
  // The scene comes from the same kernel slot the stage view reads, so its
  // name appears for any world whose plugins project one. (`label` on that
  // model describes where the art came from, not the place.)
  const scene = useUiSlot(sessionId, "stage.backdrop@1")?.value as
    StageBackdropModel | undefined;
  const sceneLabel = scene?.name ?? "";
  const worldName =
    (world && worldDisplayText(world, locale).name) ||
    t("session.breadcrumbGame");
  const turnLabel =
    sessionPhase === "setup"
      ? t("session.stateSetup")
      : sessionTurnLabel(t, turnCount);
  // Over full-bleed scene art the place is the headline; the world and turn
  // step back to a line above it.
  const sceneFirst = useThemeLayout().backdrop === "scene" && sceneLabel !== "";
  const busy =
    executing ||
    (executionState !== undefined &&
      executionState !== "idle" &&
      executionState !== "completed" &&
      !(
        recoveryNoticeVisible &&
        ["failed", "interrupted"].includes(executionState)
      ) &&
      (sessionPhase !== "setup" ||
        ["generating", "updating"].includes(executionState)));
  // Stop owns a row of its own on a phone: the view switch and menu leave no
  // room beside it, and a control hidden under them cannot be pressed.
  const showStop = Boolean(stoppable && composerHidden && onStop);
  const headerRef = useRef<HTMLDivElement>(null);
  useNoticeAnchor(headerRef);

  return (
    <div
      ref={headerRef}
      className="ui-session-header ui-panel-header ui-drag-region relative h-auto min-h-(--panel-header-height) py-1 px-2 md:px-3 flex justify-between items-center gap-3 z-10 flex-wrap sm:flex-nowrap"
    >
      <div
        className={`flex items-center gap-2 min-w-0 flex-1 ${showStop ? "max-sm:basis-full" : ""}`}
      >
        <Button
          variant="ghost"
          size="sm"
          className="ui-session-back ui-session-action h-10 shrink-0 gap-0.5 px-2 text-muted-foreground md:h-8"
          onClick={onBackToWorldSelect}
          disabled={executing}
          aria-label={t("session.breadcrumbWorldSelect")}
          title={t("session.breadcrumbWorldSelect")}
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden text-xs md:inline">{t("nav.world")}</span>
        </Button>
        <span
          aria-hidden="true"
          className="hidden h-4 w-px shrink-0 bg-(--rule-color) md:block"
        />
        <img
          src={worldVisual(world).image}
          alt=""
          aria-hidden="true"
          width={1536}
          height={1024}
          className="ui-session-thumb"
          draggable={false}
        />
        {sceneFirst ? (
          <div className="ui-session-heading min-w-0">
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              {worldName} · {turnLabel}
            </p>
            <h1 className="ui-session-title ui-title truncate text-xl leading-tight">
              {sceneLabel}
            </h1>
          </div>
        ) : (
          <>
            <h1 className="ui-session-title ui-title min-w-0 truncate text-[15px] font-semibold">
              {worldName}
            </h1>
            <span className="ui-session-turn hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {turnLabel}
            </span>
            {sceneLabel && (
              <span className="ui-chip ui-session-scene-chip hidden max-w-64 text-xs lg:inline-flex">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{sceneLabel}</span>
              </span>
            )}
          </>
        )}
        {busy && (
          <span
            className={`ui-chip hidden lg:inline-flex text-[10px] ${executionTone(sessionPhase === "setup" ? "generating" : (executionState ?? "idle"))}`}
            aria-live="polite"
          >
            <span className="ui-pulse-dot w-1.25 h-1.25 rounded-full bg-current" />
            {sessionPhase === "setup"
              ? t("session.setupRunning")
              : executionState &&
                  executionState !== "idle" &&
                  executionState !== "completed"
                ? t(`session.executionState.${executionState}`)
                : t("session.stateStreaming")}
          </span>
        )}
        {suspensionsCount > 0 && (
          <button
            type="button"
            className="ui-chip shrink-0 text-[11px] text-(--accent-warning)"
            onClick={onOpenSuspensions}
            aria-haspopup="dialog"
            title={t("session.suspensionsTitle")}
          >
            <Clock className="h-3 w-3" />
            {t("session.waitingForYou", { count: suspensionsCount })}
          </button>
        )}
        <NoticeStatusChips scope={sessionId} />
        {showStop && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            onClick={onStop}
          >
            {t("session.stopTurn")}
          </Button>
        )}
        <ConnectionStatus />
      </div>
      <div className="ml-auto flex max-w-full flex-wrap items-center gap-1 shrink-0 sm:flex-nowrap">
        <div className="ui-view-switch flex items-center border border-(--rule-color) rounded-(--radius-control)">
          <Toggle
            pressed={viewMode === "parsed"}
            onPressedChange={() => onViewModeChange("parsed")}
            size="sm"
            className="h-10 rounded-none rounded-l-[calc(var(--radius-control)-1px)] border-0 px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-(--surface-page) md:h-8"
            aria-label={t("session.viewRead")}
            title={t("session.viewRead")}
          >
            {t("session.viewRead")}
          </Toggle>
          <Toggle
            pressed={viewMode === "stage"}
            onPressedChange={() => onViewModeChange("stage")}
            size="sm"
            className={`h-10 rounded-none border-0 px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-(--surface-page) md:h-8 ${pluginViews.length > 0 ? "" : "rounded-r-[calc(var(--radius-control)-1px)]"}`}
            aria-label={t("session.viewStage")}
            title={t("session.viewStage")}
          >
            {t("session.viewStage")}
          </Toggle>
          {pluginViews.length > 0 && (
            <HeaderMenu
              label={t("session.pluginPages")}
              active={Boolean(parsePluginViewMode(viewMode))}
              icon={ChevronDown}
              triggerClassName="h-10 w-7 rounded-none rounded-r-[calc(var(--radius-control)-1px)] border-l border-(--rule-color) md:h-8"
            >
              {pluginViews.map((entry) => (
                <MenuItem
                  key={entry.mode}
                  icon={PanelsTopLeft}
                  label={entry.label}
                  secondary={entry.pluginName}
                  checked={viewMode === entry.mode}
                  onSelect={() => onViewModeChange(entry.mode)}
                />
              ))}
            </HeaderMenu>
          )}
        </div>

        {menu}

        <Button
          variant="ghost"
          size="sm"
          className={`ui-session-action h-10 shrink-0 gap-1.5 px-2 md:h-8 ${!isRightCollapsed && "bg-accent text-accent-foreground"}`}
          onClick={onToggleRightPanel}
          aria-label={t("session.sidePanel")}
          aria-pressed={!isRightCollapsed}
          title={t("session.sidePanel")}
        >
          <PanelRight className="w-4 h-4" />
          <span className="hidden text-xs sm:inline">
            {t("session.sidePanel")}
          </span>
        </Button>
      </div>
    </div>
  );
}
