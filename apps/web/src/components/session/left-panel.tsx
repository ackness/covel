import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  History,
  KeyRound,
  Plus,
  PanelLeftClose,
  Trash2,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog.js";
import { ActiveModelSlots } from "./active-model-slots.js";
import { PluginListPanel } from "./plugin-list-panel.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type {
  SessionRecord,
  PackageSummary,
  CommandSummary,
  PluginLoadError,
  SessionPluginInfo,
} from "@/services/api.js";

export interface LeftPanelProps {
  session: SessionRecord;
  phase: string;
  isLeftCollapsed: boolean;
  showSessionList: boolean;
  otherSessions: SessionRecord[];
  enabledPackages: PackageSummary[];
  pluginLoadErrors: PluginLoadError[];
  sessionPlugins: SessionPluginInfo[];
  executing: boolean;
  commands: CommandSummary[];
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
  phase,
  isLeftCollapsed,
  showSessionList,
  otherSessions,
  enabledPackages,
  pluginLoadErrors,
  sessionPlugins,
  executing,
  commands,
  resolvedSlots,
  onToggleLeftPanel,
  onToggleSessionList,
  onSwitchSession,
  onDeleteSession,
  onCloseSessionList,
  onOpenSettings,
  onResetSession,
  onTogglePlugin,
}: LeftPanelProps) {
  const { t } = useTranslation();
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteSession(deleteTarget.id);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, onDeleteSession]);

  return (
    <>
      <div className="h-14 px-3 border-b border-border bg-background flex items-center justify-between shrink-0 paper:h-[52px] paper:bg-card">
        <h2 className="font-display font-bold text-sm uppercase tracking-widest flex items-center gap-2 whitespace-nowrap paper:font-serif paper:italic paper:font-normal paper:text-[15px] paper:tracking-normal paper:normal-case">
          <SlidersHorizontal className="w-4 h-4 shrink-0 paper:hidden" />
          <span
            className={isLeftCollapsed ? "hidden" : "hidden sm:inline-block"}
          >
            {t("session.config", "Studio Config")}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-sm ml-2 shrink-0 paper:rounded-full paper:border paper:border-border"
          onClick={onToggleLeftPanel}
        >
          <PanelLeftClose className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col">
          {/* ── Current Session ── */}
          <div className="px-3 py-2.5 border-b border-border space-y-1.5 paper:px-5 paper:py-4 paper:space-y-2">
            <div className="paper:mb-0.5">
              <span className="hidden paper:inline-block paper-eyebrow">
                {t("session.currentWorld", "当前会话")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${session ? "bg-green-500 animate-pulse" : "bg-muted-foreground"} paper:w-[5px] paper:h-[5px]`}
                />
                <Badge variant="secondary" className="text-[10px] paper:bg-transparent paper:border paper:border-border paper:rounded-full paper:px-2 paper:py-[1px] paper:text-[10px] paper:uppercase paper:tracking-[0.08em] paper:font-mono">
                  {phase}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onToggleSessionList}
                title={t("session.switchSession")}
              >
                <History className="w-3 h-3" />
              </Button>
            </div>
            <p className="text-[11px] font-mono text-foreground break-all leading-relaxed paper:text-muted-foreground">
              {session.id}
            </p>
          </div>

          {/* ── Session List (expandable) ── */}
          {showSessionList && (
            <div className="px-3 py-2.5 border-b border-border space-y-1.5 bg-muted/20">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("session.sessions")}
              </h3>
              {otherSessions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">
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
                        className="flex-1 text-left px-2 py-1.5 text-[11px] font-mono truncate min-w-0"
                      >
                        <span className="block truncate">{s.id}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {s.status} · turn {s.turnCount} · {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        onClick={() => setDeleteTarget(s)}
                        className="shrink-0 p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                        title={t("common.delete", "Delete")}
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
          <div className="px-3 py-3 border-b border-border space-y-2 paper:px-5 paper:py-4 paper:space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground paper:paper-eyebrow paper:font-mono paper:font-normal paper:tracking-[0.12em]">
              {t("session.activeModels", "Models")}
            </h3>
            <ActiveModelSlots slots={resolvedSlots} variant="compact" />
          </div>

          {/* ── Plugins ── */}
          <div className="px-3 py-3 border-b border-border space-y-2 paper:px-5 paper:py-4 paper:space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground paper:paper-eyebrow paper:font-mono paper:font-normal paper:tracking-[0.12em] flex items-center justify-between">
              <span>{t("session.plugins", "Plugins")}</span>
              {enabledPackages.length > 0 && (
                <span className="ml-1 font-normal paper:text-muted-foreground">
                  {enabledPackages.length}
                </span>
              )}
            </h3>
            <PluginListPanel
              packages={enabledPackages}
              loadErrors={pluginLoadErrors}
              sessionPlugins={sessionPlugins}
              executing={executing}
              onTogglePlugin={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={session.id}
            />
          </div>

          {/* ── Commands ── */}
          {commands.length > 0 && (
            <div className="px-3 py-3 border-b border-border space-y-2 paper:px-5 paper:py-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground paper:paper-eyebrow paper:font-mono paper:font-normal paper:tracking-[0.12em]">
                {t("session.commands")}
              </h3>
              <div className="space-y-0.5">
                {commands.map((cmd) => (
                  <div
                    key={cmd.name}
                    className="flex items-center gap-2 py-1 text-xs"
                  >
                    <span className="font-mono text-primary shrink-0">
                      /{cmd.name}
                    </span>
                    <span className="text-muted-foreground truncate text-[11px]">
                      {cmd.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* ── Bottom Actions (sticky) ── */}
      <div className="px-3 py-2 border-t border-border bg-background shrink-0 space-y-1.5 paper:bg-card paper:px-5 paper:py-3 paper:space-y-2">
        <Button
          className="w-full rounded-none h-8 text-xs paper:rounded-md paper:h-9 paper:text-[12.5px] paper:border-border"
          variant="outline"
          onClick={onOpenSettings}
        >
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          {t("nav.settings", "Settings")}
        </Button>
        <Button
          className="w-full rounded-none h-8 text-xs paper:rounded-md paper:h-9 paper:text-[12.5px] paper:border paper:border-dashed paper:border-[color:var(--color-border)]"
          variant="ghost"
          onClick={onResetSession}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          {t("common.newSession")}
        </Button>
      </div>

      {/* Delete session confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("session.deleteConfirmTitle", "Delete Session")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "session.deleteConfirmDesc",
                "This will permanently delete the session and all its data (messages, game state, etc.). This action cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <p className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1.5 break-all">
              {deleteTarget.id}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" disabled={deleting}>
                {t("common.cancel", "Cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting
                ? t("common.deleting", "Deleting...")
                : t("common.delete", "Delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
