import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { History, Plus, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ActiveModelSlots } from "./active-model-slots.js";
import { confirmDeleteSession } from "./confirm-delete-session.js";
import { PluginListPanel } from "./plugin-list-panel.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type {
  SessionRecord,
  PluginSummary,
  PluginLoadError,
  SessionPlugin,
} from "@/services/api.js";
import {
  formatSessionDate,
  sessionStatusLabel,
  sessionTurnLabel,
} from "@/lib/session-display.js";
import { ignoreError } from "@/lib/ignore-error.js";

export interface LeftPanelProps {
  session: SessionRecord;
  /** Name of the session's world; names a save in the delete prompt. */
  worldName?: string;
  isLeftCollapsed: boolean;
  showSessionList: boolean;
  otherSessions: SessionRecord[];
  enabledPlugins: PluginSummary[];
  pluginLoadErrors: PluginLoadError[];
  sessionPlugins: SessionPlugin[];
  executing: boolean;
  resolvedSlots: ResolvedSlot[];
  onToggleLeftPanel: () => void;
  onToggleSessionList: () => void;
  onSwitchSession: (session: SessionRecord) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onCloseSessionList: () => void;
  onOpenSettings: () => void;
  onResetSession: () => void;
  onTogglePlugin: (pluginId: string, enable: boolean) => void;
}

export function LeftPanel({
  session,
  worldName,
  showSessionList,
  otherSessions,
  enabledPlugins,
  pluginLoadErrors,
  sessionPlugins,
  executing,
  resolvedSlots,
  onToggleSessionList,
  onSwitchSession,
  onDeleteSession,
  onCloseSessionList,
  onOpenSettings,
  onResetSession,
  onTogglePlugin,
}: LeftPanelProps) {
  const { t, i18n } = useTranslation();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleRequestDelete = useCallback(
    async (target: SessionRecord) => {
      if (deletingId) return;
      const approved = await confirmDeleteSession(
        t,
        i18n.resolvedLanguage ?? i18n.language,
        target,
        worldName,
      );
      if (!approved) return;
      setDeletingId(target.id);
      try {
        await onDeleteSession(target.id);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, t, i18n, worldName, onDeleteSession],
  );

  return (
    <>
      <div className="ui-panel-header px-3 flex items-center gap-2">
        <span className="ui-meta text-xs text-muted-foreground">§ STUDIO</span>
        <h2 className="ui-title text-sm font-medium whitespace-nowrap truncate">
          {t("session.config", "Studio Config")}
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col">
          {/* ── Current Session ── */}
          <div className="ui-panel-section border-b border-border space-y-2">
            <span className="ui-eyebrow">{t("session.currentWorld")}</span>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${session ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`}
                />
                <Badge variant="secondary" className="ui-chip text-xs">
                  {sessionStatusLabel(t, session.status)} ·{" "}
                  {sessionTurnLabel(t, session.completedPlayerTurns)}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={onToggleSessionList}
                title={t("session.switchSession")}
              >
                <History className="w-3 h-3" />
              </Button>
            </div>
            <p className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
              {session.id}
            </p>
          </div>

          {/* ── Session List (expandable) ── */}
          {showSessionList && (
            <div className="px-3 py-2.5 border-b border-border space-y-1.5 bg-muted/20">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("session.sessions")}
              </h3>
              {otherSessions.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {t("session.noOtherSessions")}
                </p>
              ) : (
                <div className="space-y-1">
                  {otherSessions.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-1 bg-background border border-border hover:border-primary/50 transition-colors"
                    >
                      <button
                        onClick={() => {
                          onSwitchSession(s);
                          onCloseSessionList();
                        }}
                        className="flex-1 text-left px-2 py-1.5 text-xs font-mono truncate min-w-0"
                      >
                        <span className="block truncate">{s.id}</span>
                        <span className="text-xs text-muted-foreground">
                          {sessionStatusLabel(t, s.status)} ·{" "}
                          {sessionTurnLabel(t, s.completedPlayerTurns)} ·{" "}
                          {formatSessionDate(
                            s.createdAt,
                            i18n.resolvedLanguage ?? i18n.language,
                          )}
                        </span>
                      </button>
                      <button
                        onClick={() =>
                          void handleRequestDelete(s).catch(
                            // The transport has already reported why it failed.
                            ignoreError("delete session"),
                          )
                        }
                        disabled={Boolean(deletingId)}
                        className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        title={t("common.delete", "Delete")}
                        aria-label={t("session.deleteSessionAria", {
                          id: s.id,
                        })}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Models ── */}
          <div className="ui-panel-section border-b border-border space-y-3">
            <h3 className="ui-eyebrow text-xs">
              {t("session.activeModels", "Models")}
            </h3>
            <ActiveModelSlots slots={resolvedSlots} variant="compact" />
          </div>

          {/* ── Plugins ── */}
          <div className="ui-panel-section border-b border-border space-y-3">
            <h3 className="ui-eyebrow text-xs flex items-center justify-between">
              <span>{t("session.plugins", "Plugins")}</span>
              {sessionPlugins.length > 0 && (
                <span className="ml-1 font-normal text-muted-foreground">
                  {sessionPlugins.filter((plugin) => plugin.active).length}/
                  {sessionPlugins.length}
                </span>
              )}
            </h3>
            <PluginListPanel
              key={session.id}
              plugins={enabledPlugins}
              loadErrors={pluginLoadErrors}
              sessionPlugins={sessionPlugins}
              executing={executing}
              onTogglePlugin={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={session.id}
              runtimeModelOverrides={session.runtimeModelOverrides}
              setupRuntimes={session.setupRuntimes}
            />
          </div>
        </div>
      </div>

      {/* ── Bottom Actions (sticky) ── */}
      <div className="ui-panel-footer flex shrink-0 flex-col gap-0.5">
        <button
          type="button"
          className="ui-btn ui-btn-quiet h-8 w-full justify-start gap-2.5 px-2 text-xs"
          onClick={onOpenSettings}
        >
          <Settings
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate">{t("nav.settings", "Settings")}</span>
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet h-8 w-full justify-start gap-2.5 px-2 text-xs"
          onClick={onResetSession}
        >
          <Plus
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="truncate">{t("common.newSession")}</span>
        </button>
      </div>
    </>
  );
}
