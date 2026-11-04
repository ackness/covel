import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bug,
  Code,
  Database,
  Download,
  ListTree,
  Menu,
  RotateCcw,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { TFunction } from "i18next";
import { MusicMenuControls } from "../session-music.js";
import {
  HeaderMenu,
  MenuHeading,
  MenuItem,
  MenuSeparator,
} from "./header-menu.js";
import type { GameViewMode } from "./game-view-header.js";

interface SessionMenuProps {
  readonly t: TFunction;
  readonly sessionId: string;
  readonly executing: boolean;
  /** Gates the developer section. */
  readonly developerMode: boolean;
  readonly viewMode: GameViewMode;
  readonly onViewModeChange: (mode: GameViewMode) => void;
  /** This game's theme choice; draws nothing when no plugin offers themes. */
  readonly themeSection: ReactNode;
  readonly onOpenGameSettings: () => void;
  readonly onOpenSettings: () => void;
  readonly onRestart: () => void;
  readonly onExport: () => void;
  readonly onOpenDatabase: () => void;
}

/**
 * The one session menu: this game, quick preferences, and (in developer mode)
 * the author tools. Everything else that used to sit in the header lives here.
 */
export function SessionMenu({
  t,
  sessionId,
  executing,
  developerMode,
  viewMode,
  onViewModeChange,
  themeSection,
  onOpenGameSettings,
  onOpenSettings,
  onRestart,
  onExport,
  onOpenDatabase,
}: SessionMenuProps) {
  return (
    <HeaderMenu
      label={t("session.menu")}
      text={t("session.menu")}
      icon={Menu}
      active={false}
    >
      <MenuHeading>{t("session.menuThisGame")}</MenuHeading>
      <MenuItem
        icon={SlidersHorizontal}
        label={t("session.menuGameSettings")}
        onSelect={onOpenGameSettings}
      />
      <MenuItem
        icon={RotateCcw}
        label={t("session.menuRestart")}
        disabled={executing}
        onSelect={onRestart}
      />
      <MenuItem
        icon={Download}
        label={t("session.menuExport")}
        onSelect={onExport}
      />
      <MenuSeparator />
      <MenuHeading>{t("session.menuPreferences")}</MenuHeading>
      <MusicMenuControls sessionId={sessionId} t={t} />
      {themeSection}
      <MenuItem
        icon={Settings}
        label={t("session.menuSettings")}
        onSelect={onOpenSettings}
      />
      {developerMode && (
        <>
          <MenuSeparator />
          <MenuHeading>{t("session.menuDeveloper")}</MenuHeading>
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
          <Link
            to="/debug"
            search={{ sid: sessionId }}
            className="ui-menu-item flex h-9 w-full items-center gap-2.5 rounded-(--radius-control) px-2.5 text-left text-[13px] hover:bg-muted/60"
          >
            <Bug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t("session.debugTraces")}
          </Link>
          <MenuItem
            icon={Database}
            label={t("session.database")}
            onSelect={onOpenDatabase}
          />
        </>
      )}
    </HeaderMenu>
  );
}
