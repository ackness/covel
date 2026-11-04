import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { confirmDeleteSession } from "./confirm-delete-session.js";
import { OrchestrationSettings } from "./orchestration-settings.js";
import { PluginListPanel } from "./plugin-list-panel.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import type {
  PluginLoadError,
  PluginSummary,
  SessionPlugin,
  SessionRecord,
  WorldRecord,
} from "@/services/api.js";
import { sessionSaveLabel } from "@/lib/session-display.js";
import { worldDisplayText } from "@/lib/world-locale.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { useSetting } from "@/settings/use-settings.js";

export interface SessionSettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionRecord;
  world: WorldRecord | null;
  otherSessions: SessionRecord[];
  plugins: PluginSummary[];
  pluginLoadErrors: PluginLoadError[];
  sessionPlugins: SessionPlugin[];
  executing: boolean;
  resolvedSlots: ResolvedSlot[];
  /** Refresh the world's other saves; called each time the drawer opens. */
  onLoadSessions: () => void;
  onSwitchSession: (session: SessionRecord) => void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onTogglePlugin: (pluginId: string, enable: boolean) => void;
  /** Open the settings dialog on the model pane. */
  onOpenModelSettings: () => void;
}

/**
 * "This game's settings": the saves of this world, the plugins on in this
 * game, and (collapsed) the speaking and advancing limits. It opens from the
 * session menu and replaces the old studio rail.
 */
export function SessionSettingsDrawer({
  open,
  onOpenChange,
  session,
  world,
  otherSessions,
  plugins,
  pluginLoadErrors,
  sessionPlugins,
  executing,
  resolvedSlots,
  onLoadSessions,
  onSwitchSession,
  onDeleteSession,
  onTogglePlugin,
  onOpenModelSettings,
}: SessionSettingsDrawerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [developerMode] = useSetting<boolean>("ui.developerView");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const worldName = world ? worldDisplayText(world, session.locale).name : "";

  useEffect(() => {
    if (open) onLoadSessions();
    // Loading the list is the drawer's own job each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const requestDelete = useCallback(
    async (target: SessionRecord) => {
      if (deletingId) return;
      if (!(await confirmDeleteSession(t, locale, target, worldName))) return;
      setDeletingId(target.id);
      try {
        await onDeleteSession(target.id);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, t, locale, worldName, onDeleteSession],
  );

  const activeCount = sessionPlugins.filter((plugin) => plugin.active).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-covel-host-controls=""
        data-testid="session-settings-drawer"
        className="inset-y-0 left-auto right-0 top-0 flex h-dvh max-w-md translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0"
      >
        <DialogHeader className="ui-panel-header border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            {t("session.drawerTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("session.drawerDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <section
            aria-label={t("session.drawerSaves")}
            className="ui-panel-section space-y-2 border-b border-border"
          >
            <h3 className="ui-eyebrow text-xs">{t("session.drawerSaves")}</h3>
            <div>
              <p className="ui-meta text-[10px] text-muted-foreground">
                {t("session.currentSave")}
              </p>
              <p className="text-sm">
                {sessionSaveLabel(t, locale, session, worldName)}
              </p>
              {developerMode && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {session.id}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <p className="ui-meta text-[10px] text-muted-foreground">
                {t("session.savesTitle")}
              </p>
              {otherSessions.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                  {t("session.noOtherSaves")}
                </p>
              ) : (
                otherSessions.map((other) => {
                  const label = sessionSaveLabel(t, locale, other, worldName);
                  return (
                    <div
                      key={other.id}
                      className="flex items-center gap-1 border border-border bg-background transition-colors hover:border-primary/50"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSwitchSession(other);
                          onOpenChange(false);
                        }}
                        aria-label={`${t("session.switchSave")}: ${label}`}
                        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                      >
                        {label}
                        {developerMode && (
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {other.id}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void requestDelete(other).catch(
                            // The transport has already reported why it failed.
                            ignoreError("delete session"),
                          )
                        }
                        disabled={Boolean(deletingId)}
                        className="shrink-0 p-1.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                        title={t("common.delete", "Delete")}
                        aria-label={t("session.deleteSessionAria", { label })}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section
            aria-label={t("session.drawerPlugins")}
            className="ui-panel-section space-y-3 border-b border-border"
          >
            <h3 className="ui-eyebrow flex items-center justify-between text-xs">
              <span>{t("session.drawerPlugins")}</span>
              {sessionPlugins.length > 0 && (
                <span className="ml-1 font-normal text-muted-foreground">
                  {activeCount}/{sessionPlugins.length}
                </span>
              )}
            </h3>
            <PluginListPanel
              plugins={plugins}
              loadErrors={pluginLoadErrors}
              sessionPlugins={sessionPlugins}
              executing={executing}
              onTogglePlugin={onTogglePlugin}
              resolvedSlots={resolvedSlots}
              sessionId={session.id}
              runtimeModelOverrides={session.runtimeModelOverrides}
              setupRuntimes={session.setupRuntimes}
              developerMode={developerMode}
              onOpenModelSettings={onOpenModelSettings}
            />
          </section>

          <details className="ui-panel-section group">
            <summary className="ui-eyebrow cursor-pointer text-xs">
              {t("session.drawerAdvanced")}
            </summary>
            <div className="mt-3">
              <OrchestrationSettings
                key={session.id}
                sessionId={session.id}
                disabled={executing}
                refreshKey={sessionPlugins}
              />
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
