import { Link } from "@tanstack/react-router";
import {
  Bug,
  Clock,
  Code,
  Database,
  KeyRound,
  LayoutTemplate,
  ListTree,
  SlidersHorizontal,
} from "lucide-react";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button.js";
import { Toggle } from "@/components/ui/toggle.js";
import type { WorldRecord } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { SessionBreadcrumb } from "../session-breadcrumb.js";

export type GameViewMode = "parsed" | "detailed" | "raw";

interface GameViewHeaderProps {
  t: TFunction;
  sessionId: string;
  world: WorldRecord | null;
  executing: boolean;
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

export function GameViewHeader({
  t,
  sessionId,
  world,
  executing,
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
  return (
    <div className="ui-panel-header px-3 flex justify-between items-center gap-2 z-10">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 border border-border/80 ${!isLeftCollapsed && "bg-accent text-accent-foreground"}`}
          onClick={onToggleLeftPanel}
          aria-label={t("session.toggleStoryPanel")}
          title={t("session.toggleStoryPanel")}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </Button>
        <SessionBreadcrumb
          step="game"
          worldName={text(world?.name)}
          onGoWorldSelect={onBackToWorldSelect}
          onGoPrep={onResetSession}
          disabled={executing}
        />
        <span
          className={`ui-chip hidden lg:inline-flex ml-1 text-[10px] ${
            executing
              ? "border-transparent bg-[color-mix(in_oklab,var(--accent-primary)_12%,transparent)] text-[var(--accent-primary)]"
              : "border-transparent bg-[color-mix(in_oklab,var(--accent-success)_14%,transparent)] text-[var(--accent-success)]"
          }`}
          aria-live="polite"
        >
          <span
            className={`w-[5px] h-[5px] rounded-full bg-current ${executing ? "ui-pulse-dot" : ""}`}
          />
          {executing ? t("session.stateStreaming") : t("session.statePlaying")}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex items-center border border-[var(--rule-color)] rounded-[var(--radius-control)] overflow-hidden">
          <Toggle
            pressed={viewMode === "parsed"}
            onPressedChange={() => onViewModeChange("parsed")}
            size="sm"
            className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-foreground data-[state=on]:text-[var(--surface-page)]"
            aria-label={t("session.viewParsedAria")}
            title={t("session.viewParsed")}
          >
            <LayoutTemplate className="w-3.5 h-3.5" />
          </Toggle>
          <Toggle
            pressed={viewMode === "detailed"}
            onPressedChange={() => onViewModeChange("detailed")}
            size="sm"
            className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-foreground data-[state=on]:text-[var(--surface-page)]"
            aria-label={t("session.viewDetailedAria")}
            title={t("session.viewDetailed")}
          >
            <ListTree className="w-3.5 h-3.5" />
          </Toggle>
          <Toggle
            pressed={viewMode === "raw"}
            onPressedChange={() => onViewModeChange("raw")}
            size="sm"
            className="rounded-none border-0 h-7 px-2 data-[state=on]:bg-foreground data-[state=on]:text-[var(--surface-page)]"
            aria-label={t("session.viewRawAria")}
            title={t("session.viewRaw")}
          >
            <Code className="w-3.5 h-3.5" />
          </Toggle>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onOpenSettings}
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <KeyRound className="w-3.5 h-3.5" />
        </Button>

        {suspensionsCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 shrink-0 gap-1 text-[var(--accent-warning)] hover:bg-[color-mix(in_oklab,var(--accent-warning)_8%,transparent)]"
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
          className="hidden md:inline-flex h-7 w-7 shrink-0"
          asChild
          aria-label={t("session.debugTraces")}
          title={t("session.debugTraces")}
        >
          <Link to="/debug" search={{ sid: sessionId }}>
            <Bug className="w-3.5 h-3.5" />
          </Link>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 ${!isRightCollapsed && "bg-accent text-accent-foreground"}`}
          onClick={onToggleRightPanel}
          aria-label={t("session.toggleContextPanel")}
          title={t("session.toggleContextPanel")}
        >
          <Database className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
