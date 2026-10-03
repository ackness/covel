import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Bug,
  ChevronLeft,
  Clock,
  Code,
  ListTree,
  MapPin,
  MoreHorizontal,
  PanelRight,
  Settings,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";
import type { TFunction } from "i18next";
import type { StageBackdropModel } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { Toggle } from "@/components/ui/toggle.js";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { sessionTurnLabel } from "@/lib/session-display.js";
import { worldVisual } from "@/lib/world-visuals.js";
import { useThemeLayout } from "@/theme-system/use-theme-layout.js";
import { useUiSlot } from "@/stores/ui-slot-store.js";
import { ConnectionStatus } from "./connection-status.js";
import {
  executionTone,
  type ExecutionPresentation,
} from "../execution-presentation.js";

export type GameViewMode = "parsed" | "detailed" | "raw" | "stage";

interface GameViewHeaderProps {
  t: TFunction;
  sessionId: string;
  sessionPhase: SessionRecord["phase"];
  /** Committed player turns, shown beside the world name. */
  turnCount: number;
  world: WorldRecord | null;
  executing: boolean;
  executionState?: ExecutionPresentation;
  viewMode: GameViewMode;
  isLeftCollapsed: boolean;
  isRightCollapsed: boolean;
  onViewModeChange: (mode: GameViewMode) => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onOpenSettings: () => void;
  onOpenSuspensions: () => void;
  onBackToWorldSelect: () => void;
  onResetSession: () => void;
  suspensionsCount: number;
}

/**
 * Session toolbar. The left side says where the player is — world, turn,
 * current scene; the right side holds what a player reaches for mid-story.
 * Author tools (detailed and raw message views, studio configuration, traces)
 * sit behind the overflow menu so they stay one click away without crowding
 * the bar.
 */
export function GameViewHeader({
  t,
  sessionId,
  sessionPhase,
  turnCount,
  world,
  executing,
  executionState,
  viewMode,
  isLeftCollapsed,
  isRightCollapsed,
  onViewModeChange,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenSettings,
  onOpenSuspensions,
  onBackToWorldSelect,
  onResetSession,
  suspensionsCount,
}: GameViewHeaderProps) {
  // The scene comes from the same kernel slot the stage view reads, so its
  // name appears for any world whose plugins project one. (`label` on that
  // model describes where the art came from, not the place.)
  const scene = useUiSlot(sessionId, "stage.backdrop@1")?.value as
    StageBackdropModel | undefined;
  const sceneLabel = scene?.name ?? "";
  const worldName = text(world?.name) || t("session.breadcrumbGame");
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
      executionState !== "completed");
  const authorView = viewMode === "detailed" || viewMode === "raw";

  return (
    <div className="ui-session-header ui-panel-header ui-drag-region relative px-2 md:px-3 flex justify-between items-center gap-3 z-10">
      <div className="flex items-center gap-2 min-w-0 flex-1">
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
            className={`ui-chip hidden lg:inline-flex text-[10px] ${executionTone(executionState ?? "idle")}`}
            aria-live="polite"
          >
            <span className="ui-pulse-dot w-1.25 h-1.25 rounded-full bg-current" />
            {executionState &&
            executionState !== "idle" &&
            executionState !== "completed"
              ? t(`session.executionState.${executionState}`)
              : t("session.stateStreaming")}
          </span>
        )}
        <ConnectionStatus />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <div className="ui-view-switch flex items-center border border-(--rule-color) rounded-(--radius-control) overflow-hidden">
          <Toggle
            pressed={viewMode === "parsed"}
            onPressedChange={() => onViewModeChange("parsed")}
            size="sm"
            className="h-10 rounded-none border-0 px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-(--surface-page) md:h-8"
            aria-label={t("session.viewParsedAria")}
            title={t("session.viewParsedAria")}
          >
            {t("session.viewText")}
          </Toggle>
          <Toggle
            pressed={viewMode === "stage"}
            onPressedChange={() => onViewModeChange("stage")}
            size="sm"
            className="h-10 rounded-none border-0 px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-(--surface-page) md:h-8"
            aria-label={t("session.viewStageAria")}
            title={t("session.viewStageAria")}
          >
            {t("session.viewStage")}
          </Toggle>
        </div>

        {suspensionsCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ui-session-action h-8 px-2 shrink-0 gap-1 text-(--accent-warning) hover:bg-[color-mix(in_oklab,var(--accent-warning)_8%,transparent)]"
            onClick={onOpenSuspensions}
            aria-label={t("session.suspensionsBadge", {
              count: suspensionsCount,
            })}
            title={t("session.suspensionsTitle")}
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="text-[11px] tabular-nums">{suspensionsCount}</span>
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="ui-session-action h-10 w-10 shrink-0 md:h-8 md:w-8"
          onClick={onOpenSettings}
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <Settings className="w-4 h-4" />
        </Button>

        <HeaderMenu label={t("session.moreActions")} active={authorView}>
          <MenuItem
            icon={ListTree}
            label={t("session.viewDetailedAria")}
            checked={viewMode === "detailed"}
            onSelect={() => onViewModeChange("detailed")}
          />
          <MenuItem
            icon={Code}
            label={t("session.viewRawAria")}
            checked={viewMode === "raw"}
            onSelect={() => onViewModeChange("raw")}
          />
          <div role="separator" className="my-1 h-px bg-(--rule-color)" />
          <MenuItem
            icon={SlidersHorizontal}
            label={t("session.config", "Studio Config")}
            checked={!isLeftCollapsed}
            onSelect={onToggleLeftPanel}
          />
          <MenuItem
            icon={Undo2}
            label={t("session.breadcrumbPrep")}
            disabled={executing}
            onSelect={onResetSession}
          />
          <Link
            to="/debug"
            search={{ sid: sessionId }}
            role="menuitem"
            className="ui-menu-item flex h-9 w-full items-center gap-2.5 rounded-(--radius-control) px-2.5 text-left text-[13px] hover:bg-muted/60"
          >
            <Bug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t("session.debugTraces")}
          </Link>
        </HeaderMenu>

        <Button
          variant="ghost"
          size="icon"
          className={`ui-session-action h-10 w-10 shrink-0 md:h-8 md:w-8 ${!isRightCollapsed && "bg-accent text-accent-foreground"}`}
          onClick={onToggleRightPanel}
          aria-label={t("session.toggleContextPanel")}
          title={t("session.toggleContextPanel")}
        >
          <PanelRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

/** A click-away menu; small enough not to warrant a popover dependency. */
function HeaderMenu({
  label,
  active,
  children,
}: {
  readonly label: string;
  /** Marks the trigger when an option inside is switched on. */
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={`ui-session-action h-10 w-10 shrink-0 md:h-8 md:w-8 ${(open || active) && "bg-accent text-accent-foreground"}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="ui-dialog-shell absolute right-0 top-full z-30 mt-1.5 min-w-48 p-1"
          // Any choice closes the menu; the items handle their own action.
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  checked,
  disabled,
  onSelect,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={`ui-menu-item flex h-9 w-full items-center gap-2.5 rounded-(--radius-control) px-2.5 text-left text-[13px] hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50 ${
        checked ? "text-(--accent-primary) font-medium" : ""
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {label}
    </button>
  );
}
